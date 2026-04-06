import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import { fileURLToPath } from 'url';

export function createPptxParseLambda(
  stack: Stack,
  userPool: IUserPool,
  userPoolClient: IUserPoolClient
) {
  const logGroup = new logs.LogGroup(stack, 'PptxParseLogGroup', {
    logGroupName: '/ai-manager/pptx-parse',
    retention: logs.RetentionDays.ONE_MONTH, // ログ保持期間（デフォルトは無期限）
    removalPolicy: RemovalPolicy.DESTROY, // sandbox 削除時にロググループも削除
  });

  const pptxParseFn = new lambda.DockerImageFunction(stack, 'PptxParseFn', {
    code: lambda.DockerImageCode.fromImageAsset(
      path.dirname(fileURLToPath(import.meta.url)),
      { platform: Platform.LINUX_ARM64 }
    ),
    architecture: lambda.Architecture.ARM_64,
    memorySize: 512,
    timeout: Duration.seconds(30),
    description: 'PPTX ファイル解析（テキスト・構造抽出）',
    logGroup,
  });

  const jwtAuthorizer = new apigatewayv2Authorizers.HttpJwtAuthorizer(
    'PptxParseAuthorizer',
    `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}`,
    {
      jwtAudience: [userPoolClient.userPoolClientId],
    }
  );

  const httpApi = new apigatewayv2.HttpApi(stack, 'PptxParseApi', {
    apiName: 'pptx-parse-api',
    corsPreflight: {
      allowOrigins: ['*'],
      allowMethods: [apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.OPTIONS],
      allowHeaders: ['Content-Type', 'Authorization'],
    },
  });

  httpApi.addRoutes({
    path: '/api/pptx/parse',
    methods: [apigatewayv2.HttpMethod.POST],
    integration: new apigatewayv2Integrations.HttpLambdaIntegration(
      'PptxParseIntegration',
      pptxParseFn
    ),
    authorizer: jwtAuthorizer,
  });

  return { httpApi, pptxParseFn };
}
