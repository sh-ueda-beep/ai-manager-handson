import { Duration, Fn } from 'aws-cdk-lib';
import type { Stack } from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';

export function createConversationMemory(stack: Stack) {
  const envId = Fn.select(2, Fn.split('-', stack.stackName));

  // NOTE: RemovalPolicy は alpha L2 の制約で未設定（default=DESTROY）。
  // L2 の Memory 構築子は内部 CfnMemory を private (__resource) に保持しており
  // node.defaultChild が未公開のため applyRemovalPolicy が動作しない。
  // 将来 L2 が stable 化し defaultChild を公開したら RETAIN を検討する。
  const memory = new agentcore.Memory(stack, 'ConversationMemory', {
    memoryName: `pptx_review_memory_${envId}`,
    description: 'Conversation history for PPTX review sessions',
    expirationDuration: Duration.days(180),
  });

  return { memory };
}
