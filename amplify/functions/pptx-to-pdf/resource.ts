import { Stack, Duration, RemovalPolicy, Size } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { fileURLToPath } from 'url';

export function createPptxToPdfLambda(
  stack: Stack,
  httpApi: apigatewayv2.HttpApi,
  jwtAuthorizer: HttpJwtAuthorizer,
  dataSourceBucket: s3.IBucket,
  knowledgeBaseId: string,
  dataSourceId: string,
) {
  const logGroup = new logs.LogGroup(stack, 'PptxToPdfLogGroup', {
    logGroupName: '/ai-manager/pptx-to-pdf',
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const pptxToPdfFn = new lambda.DockerImageFunction(stack, 'PptxToPdfFn', {
    code: lambda.DockerImageCode.fromImageAsset(
      path.dirname(fileURLToPath(import.meta.url)),
      { platform: Platform.LINUX_ARM64 }
    ),
    architecture: lambda.Architecture.ARM_64,
    memorySize: 3008,
    timeout: Duration.minutes(5),
    // /tmp 容量は LibreOffice の作業領域として余裕を持たせる
    ephemeralStorageSize: Size.mebibytes(2048),
    description: 'PPTX を LibreOffice で PDF に変換してナレッジベースに登録',
    logGroup,
    environment: {
      BUCKET_NAME: dataSourceBucket.bucketName,
      KNOWLEDGE_BASE_ID: knowledgeBaseId,
      DATA_SOURCE_ID: dataSourceId,
    },
  });

  // データソース S3 への書込権限
  dataSourceBucket.grantWrite(pptxToPdfFn);

  // Bedrock インジェストジョブ起動権限
  pptxToPdfFn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
    resources: [`arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/*`],
  }));

  const integration = new apigatewayv2Integrations.HttpLambdaIntegration(
    'PptxToPdfIntegration',
    pptxToPdfFn
  );

  httpApi.addRoutes({
    path: '/api/documents/upload-pptx',
    methods: [apigatewayv2.HttpMethod.POST],
    integration,
    authorizer: jwtAuthorizer,
  });

  return { pptxToPdfFn };
}
