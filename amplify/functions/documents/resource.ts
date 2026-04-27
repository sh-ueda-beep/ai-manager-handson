import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { fileURLToPath } from 'url';

export function createDocumentsApi(
  stack: Stack,
  userPool: IUserPool,
  userPoolClient: IUserPoolClient,
  dataSourceBucket: s3.IBucket,
  knowledgeBaseId: string,
  dataSourceId: string,
) {
  const logGroup = new logs.LogGroup(stack, 'DocumentsLogGroup', {
    logGroupName: '/ai-manager/documents',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const documentsFn = new lambda.DockerImageFunction(stack, 'DocumentsFn', {
    code: lambda.DockerImageCode.fromImageAsset(
      path.dirname(fileURLToPath(import.meta.url)),
      { platform: Platform.LINUX_ARM64 }
    ),
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout: Duration.seconds(60),
    description: 'マークダウンドキュメント管理（アップロード・一覧・削除）',
    logGroup,
    environment: {
      BUCKET_NAME: dataSourceBucket.bucketName,
      KNOWLEDGE_BASE_ID: knowledgeBaseId,
      DATA_SOURCE_ID: dataSourceId,
    },
  });

  // S3 バケットへの読み書き権限
  dataSourceBucket.grantReadWrite(documentsFn);

  // Bedrock Agent の StartIngestionJob / GetIngestionJob 権限
  documentsFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
    resources: [`arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/*`],
  }));

  const jwtAuthorizer = new apigatewayv2Authorizers.HttpJwtAuthorizer(
    'DocumentsAuthorizer',
    `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}`,
    { jwtAudience: [userPoolClient.userPoolClientId] }
  );

  const httpApi = new apigatewayv2.HttpApi(stack, 'DocumentsApi', {
    apiName: 'documents-api',
    corsPreflight: {
      allowOrigins: ['*'],
      allowMethods: [
        apigatewayv2.CorsHttpMethod.GET,
        apigatewayv2.CorsHttpMethod.POST,
        apigatewayv2.CorsHttpMethod.DELETE,
        apigatewayv2.CorsHttpMethod.OPTIONS,
      ],
      allowHeaders: ['Content-Type', 'Authorization'],
    },
  });

  const integration = new apigatewayv2Integrations.HttpLambdaIntegration(
    'DocumentsIntegration',
    documentsFn
  );

  httpApi.addRoutes({
    path: '/api/documents/upload',
    methods: [apigatewayv2.HttpMethod.POST],
    integration,
    authorizer: jwtAuthorizer,
  });

  // PPTX バッチ登録の最後に 1 回呼ぶ専用エンドポイント
  httpApi.addRoutes({
    path: '/api/documents/start-ingestion',
    methods: [apigatewayv2.HttpMethod.POST],
    integration,
    authorizer: jwtAuthorizer,
  });

  httpApi.addRoutes({
    path: '/api/documents',
    methods: [apigatewayv2.HttpMethod.GET],
    integration,
    authorizer: jwtAuthorizer,
  });

  httpApi.addRoutes({
    path: '/api/documents/{key+}',
    methods: [apigatewayv2.HttpMethod.DELETE],
    integration,
    authorizer: jwtAuthorizer,
  });

  // インジェストジョブ進捗ポーリング
  httpApi.addRoutes({
    path: '/api/documents/ingestion-jobs/{jobId}',
    methods: [apigatewayv2.HttpMethod.GET],
    integration,
    authorizer: jwtAuthorizer,
  });

  return { httpApi, documentsFn, jwtAuthorizer, integration };
}
