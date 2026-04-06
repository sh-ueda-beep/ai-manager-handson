import { Stack, RemovalPolicy, Fn } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';

export function createKnowledgeBase(stack: Stack) {
  // Amplify 環境ごとにリソース名を一意にするための suffix
  const envId = Fn.select(2, Fn.split('-', stack.stackName));

  // --- データソース用 S3 バケット ---
  const dataSourceBucket = new s3.Bucket(stack, 'DocumentBucket', {
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  // --- S3 Vector Bucket ---
  const vectorBucket = new s3vectors.CfnVectorBucket(stack, 'VectorBucket', {
    vectorBucketName: `ai-manager-kb-vectors-${stack.account}`,
  });

  // --- S3 Vector Index ---
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

  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
    ],
  }));

  kbRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:ListBucket'],
    resources: [
      dataSourceBucket.bucketArn,
      `${dataSourceBucket.bucketArn}/*`,
    ],
  }));

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
  const knowledgeBase = new bedrock.CfnKnowledgeBase(stack, 'KnowledgeBase', {
    name: `ai-manager-kb`,
    roleArn: kbRole.roleArn,
    knowledgeBaseConfiguration: {
      type: 'VECTOR',
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
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

  // --- Bedrock Data Source ---
  const dataSource = new bedrock.CfnDataSource(stack, 'DataSource', {
    name: `ai-manager-datasource`,
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    dataSourceConfiguration: {
      type: 'S3',
      s3Configuration: {
        bucketArn: dataSourceBucket.bucketArn,
      },
    },
  });

  return {
    dataSourceBucket,
    knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    dataSourceId: dataSource.attrDataSourceId,
  };
}
