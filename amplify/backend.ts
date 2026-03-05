import { defineBackend } from '@aws-amplify/backend';
import { Tags } from 'aws-cdk-lib';
import { auth } from './auth/resource';
import { createPptxParseLambda } from './functions/pptx-parse/resource';
import { createAgentCoreRuntime } from './agent/resource';

const backend = defineBackend({
  auth,
});

Tags.of(backend.stack).add('Project', 'ai-manager');
Tags.of(backend.stack).add('ManagedBy', 'amplify');

// PPTX 解析 Lambda + API Gateway
const pptxParseStack = backend.createStack('PptxParseStack');
Tags.of(pptxParseStack).add('Project', 'ai-manager');

const { httpApi } = createPptxParseLambda(
  pptxParseStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient
);

// AgentCore Runtime（AI レビューエージェント）
const agentCoreStack = backend.createStack('AgentCoreStack');
Tags.of(agentCoreStack).add('Project', 'ai-manager');

const { runtime } = createAgentCoreRuntime(
  agentCoreStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient
);

// フロントエンドで参照する URL を出力
backend.addOutput({
  custom: {
    pptxParseApiUrl: httpApi.apiEndpoint,
    agentRuntimeArn: runtime.agentRuntimeArn,
  },
});
