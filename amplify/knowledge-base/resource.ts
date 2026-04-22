import { Stack, RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';

// Nova Multimodal Embeddings は 2025-12 時点で us-east-1 限定提供
const NOVA_MME_REGION = 'us-east-1';
const NOVA_MME_MODEL_ID = 'amazon.nova-2-multimodal-embeddings-v1:0';

// Foundation Model Parser に使うマルチモーダル理解モデル。
// Bedrock default parser は画像ファイルを処理できないため、画像をインジェストするには
// BDA か Foundation Model Parser が必要。BDA は Nova MME と組み合わせると native
// 画像埋め込みを失うため、Foundation Model Parser を採用する（docs/1.md で実証済み）。
// us. プレフィックスはクロスリージョン推論プロファイル。
const PARSER_INFERENCE_PROFILE_ID = 'us.amazon.nova-2-lite-v1:0';
const PARSER_UNDERLYING_MODEL_ID = 'amazon.nova-2-lite-v1:0';

export function createKnowledgeBase(stack: Stack) {
  // --- データソース用 S3 バケット（原本を保管、.md/.png/.jpg/.pdf 等） ---
  const dataSourceBucket = new s3.Bucket(stack, 'DocumentBucket', {
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  // --- Multimodal Storage Destination バケット（Nova MME のマルチメディア保存先） ---
  // データソースとは別バケット（AWS ベストプラクティス）、aws/ 配下の transient data
  // は Bedrock がクリーンアップを試みるが保証されないため 90 日ライフサイクルを適用
  const multimodalStorageBucket = new s3.Bucket(stack, 'MultimodalStorageBucket', {
    encryption: s3.BucketEncryption.S3_MANAGED,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    lifecycleRules: [
      {
        id: 'transient-data-cleanup',
        prefix: 'aws/',
        expiration: Duration.days(90),
      },
    ],
  });

  // --- S3 Vector Bucket ---
  const vectorBucket = new s3vectors.CfnVectorBucket(stack, 'VectorBucket', {
    vectorBucketName: `ai-manager-kb-vectors-${stack.account}`,
  });

  // --- S3 Vector Index（次元数は Nova MME の 1024 を採用） ---
  const vectorIndex = new s3vectors.CfnIndex(stack, 'VectorIndex', {
    vectorBucketName: vectorBucket.vectorBucketName!,
    indexName: 'kb-index',
    dataType: 'float32',
    dimension: 1024,
    distanceMetric: 'cosine',
    metadataConfiguration: {
      nonFilterableMetadataKeys: [
        'AMAZON_BEDROCK_TEXT',
        'AMAZON_BEDROCK_METADATA',
      ],
    },
  });
  vectorIndex.addDependency(vectorBucket);

  // --- IAM Role for Bedrock Knowledge Base ---
  const kbRole = new iam.Role(stack, 'KnowledgeBaseRole', {
    assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
  });

  // Nova Multimodal Embeddings（us-east-1）への呼び出し
  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      'bedrock:InvokeModel',
      'bedrock:StartAsyncInvoke',
      'bedrock:GetAsyncInvoke',
    ],
    resources: [
      `arn:aws:bedrock:${NOVA_MME_REGION}::foundation-model/${NOVA_MME_MODEL_ID}`,
    ],
  }));

  // Foundation Model Parser（画像・ドキュメント解析）への呼び出し。
  // クロスリージョン推論プロファイル (us.*) 経由なので、プロファイル ARN と
  // 背後の foundation-model ARN の両方に権限が必要（全リージョン対象）。
  // Bedrock KB はデータソース作成/更新時に GetInferenceProfile / GetFoundationModel
  // を呼んでメタ情報を確認するため、読み取り系も付与する必要あり。
  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      'bedrock:InvokeModel',
      'bedrock:GetInferenceProfile',
      'bedrock:GetFoundationModel',
    ],
    resources: [
      `arn:aws:bedrock:*:${stack.account}:inference-profile/${PARSER_INFERENCE_PROFILE_ID}`,
      `arn:aws:bedrock:*::foundation-model/${PARSER_UNDERLYING_MODEL_ID}`,
    ],
  }));

  // データソースバケット読取
  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:ListBucket'],
    resources: [
      dataSourceBucket.bucketArn,
      `${dataSourceBucket.bucketArn}/*`,
    ],
  }));

  // Multimodal Storage Destination への読み書き（Bedrock が transient data を置く）
  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
    ],
    resources: [
      multimodalStorageBucket.bucketArn,
      `${multimodalStorageBucket.bucketArn}/*`,
    ],
  }));

  // S3 Vectors 操作
  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: [
      's3vectors:PutVectors',
      's3vectors:GetVectors',
      's3vectors:DeleteVectors',
      's3vectors:QueryVectors',
      's3vectors:GetIndex',
    ],
    resources: [vectorIndex.attrIndexArn],
  }));

  // --- Bedrock Knowledge Base ---
  // Nova Multimodal Embeddings を使う場合、supplementalDataStorageConfiguration による
  // multimodal storage destination の指定が必須。
  // また Nova MME の既定次元は 3072 のため、1024 次元の S3 Vectors 索引に合わせて
  // embeddingModelConfiguration で dimensions を明示する必要がある。
  const knowledgeBase = new bedrock.CfnKnowledgeBase(stack, 'KnowledgeBase', {
    name: `ai-manager-kb`,
    roleArn: kbRole.roleArn,
    knowledgeBaseConfiguration: {
      type: 'VECTOR',
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: `arn:aws:bedrock:${NOVA_MME_REGION}::foundation-model/${NOVA_MME_MODEL_ID}`,
        embeddingModelConfiguration: {
          bedrockEmbeddingModelConfiguration: {
            dimensions: 1024,
            embeddingDataType: 'FLOAT32',
          },
        },
        supplementalDataStorageConfiguration: {
          supplementalDataStorageLocations: [
            {
              supplementalDataStorageLocationType: 'S3',
              s3Location: { uri: `s3://${multimodalStorageBucket.bucketName}` },
            },
          ],
        },
      },
    },
    storageConfiguration: {
      type: 'S3_VECTORS',
      s3VectorsConfiguration: {
        vectorBucketArn: vectorBucket.attrVectorBucketArn,
        indexName: vectorIndex.indexName!,
      },
    },
  });
  knowledgeBase.addDependency(vectorIndex);
  knowledgeBase.node.addDependency(kbRole);
  knowledgeBase.node.addDependency(multimodalStorageBucket);

  // --- Bedrock Data Source（Foundation Model Parser で画像・PDF も取り込む） ---
  // S3DataSourceConfiguration.inclusionPrefixes は最大 1 要素の制約あり。
  // dataSourceBucket は本 KB 専用でゴミは入らない前提なので、inclusionPrefixes は
  // 指定せずバケット全体を対象にする。multimodal storage は別バケットなので競合なし。
  //
  // vectorIngestionConfiguration.parsingConfiguration で Foundation Model Parser を
  // 明示しないと Bedrock default parser になり、画像ファイル（PNG/JPG/GIF/WEBP）の
  // インジェストジョブが失敗する（default parser はテキスト系フォーマット専用のため）。
  const dataSource = new bedrock.CfnDataSource(stack, 'DataSource', {
    name: `ai-manager-datasource`,
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    dataSourceConfiguration: {
      type: 'S3',
      s3Configuration: {
        bucketArn: dataSourceBucket.bucketArn,
      },
    },
    vectorIngestionConfiguration: {
      parsingConfiguration: {
        parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
        bedrockFoundationModelConfiguration: {
          modelArn: `arn:aws:bedrock:${NOVA_MME_REGION}:${stack.account}:inference-profile/${PARSER_INFERENCE_PROFILE_ID}`,
        },
      },
    },
  });

  return {
    dataSourceBucket,
    multimodalStorageBucket,
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    dataSourceId: dataSource.attrDataSourceId,
  };
}
