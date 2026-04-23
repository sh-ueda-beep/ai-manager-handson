import { defineBackend } from '@aws-amplify/backend';
import { App, Tags } from 'aws-cdk-lib';
import { auth } from './auth/resource';
import { createPptxParseLambda } from './functions/pptx-parse/resource';
import { createAgentCoreRuntime } from './agent/resource';
import { createKnowledgeBase } from './knowledge-base/resource';
import { createDocumentsApi } from './functions/documents/resource';
import { createPptxToPdfLambda } from './functions/pptx-to-pdf/resource';

const backend = defineBackend({
  auth,
});

// App 全体に SCP 必須タグを適用（Amplify 自動生成リソース含む）
const app = App.of(backend.stack);
if (app) {
  Tags.of(app).add('Project', 'ai-manager');
}
Tags.of(backend.stack).add('ManagedBy', 'amplify');

// 自己サインアップ無効化 + ゲストアクセス無効化
const { cfnUserPool, cfnIdentityPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};
cfnIdentityPool.allowUnauthenticatedIdentities = false;

// PPTX 解析 Lambda + API Gateway
const pptxParseStack = backend.createStack('PptxParseStack');

const { httpApi } = createPptxParseLambda(
  pptxParseStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient
);

// Knowledge Base（RAG）— AgentCore より先に定義
const kbStack = backend.createStack('KnowledgeBaseStack');

const {
  knowledgeBaseId,
  dataSourceId,
  dataSourceBucket,
  multimodalStorageBucket,
} = createKnowledgeBase(kbStack);

// AgentCore Runtime（AI レビューエージェント）
const agentCoreStack = backend.createStack('AgentCoreStack');

const { runtime } = createAgentCoreRuntime(
  agentCoreStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient,
  knowledgeBaseId,
  multimodalStorageBucket,
  dataSourceBucket,
);

// ドキュメント管理 API（マークダウン・画像・PDF アップロード）
const documentsStack = backend.createStack('DocumentsStack');

const {
  httpApi: documentsApi,
  jwtAuthorizer: documentsAuthorizer,
} = createDocumentsApi(
  documentsStack,
  backend.auth.resources.userPool,
  backend.auth.resources.userPoolClient,
  dataSourceBucket,
  knowledgeBaseId,
  dataSourceId,
);

// PPTX → PDF 変換 Lambda（LibreOffice headless 入り）
// documents API に `POST /api/documents/upload-pptx` ルートを合流させる
createPptxToPdfLambda(
  documentsStack,
  documentsApi,
  documentsAuthorizer,
  dataSourceBucket,
  knowledgeBaseId,
  dataSourceId,
);

// フロントエンドで参照する URL を出力
backend.addOutput({
  custom: {
    pptxParseApiUrl: httpApi.apiEndpoint,
    agentRuntimeArn: runtime.agentRuntimeArn,
    knowledgeBaseId,
    dataSourceId,
    documentsApiUrl: documentsApi.apiEndpoint,
  },
});
