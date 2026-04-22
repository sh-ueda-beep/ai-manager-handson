import { Stack, Fn } from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import { fileURLToPath } from 'url';

export function createAgentCoreRuntime(
  stack: Stack,
  userPool: IUserPool,
  userPoolClient: IUserPoolClient,
  knowledgeBaseId?: string,
  multimodalStorageBucket?: s3.IBucket,
  dataSourceBucket?: s3.IBucket,
) {
  const agentImage = new ContainerImageBuild(stack, 'AgentImage', {
    directory: path.dirname(fileURLToPath(import.meta.url)),
    platform: Platform.LINUX_ARM64,
  });

  const envId = Fn.select(2, Fn.split('-', stack.stackName));

  const runtime = new agentcore.Runtime(stack, 'PptxReviewRuntime', {
    runtimeName: `pptx_review_${envId}`,
    agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
      agentImage.repository,
      agentImage.imageTag
    ),
    authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
      userPool,
      [userPoolClient],
    ),
    networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
    environmentVariables: {
      ...(knowledgeBaseId ? { KNOWLEDGE_BASE_ID: knowledgeBaseId } : {}),
      // Knowledge Base / Nova MME は us-east-1 に配置される前提
      KB_REGION: 'us-east-1',
    },
  });

  // Bedrock API の利用権限
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    })
  );

  // Knowledge Base 検索権限（us-east-1 の KB を参照）
  runtime.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['bedrock:Retrieve'],
      resources: ['arn:aws:bedrock:*:*:knowledge-base/*'],
    })
  );

  // 画像チャンクの vision 展開のため、参照先 S3 バケットへの GetObject 権限
  if (multimodalStorageBucket) {
    multimodalStorageBucket.grantRead(runtime);
  }
  if (dataSourceBucket) {
    dataSourceBucket.grantRead(runtime);
  }

  return { runtime };
}
