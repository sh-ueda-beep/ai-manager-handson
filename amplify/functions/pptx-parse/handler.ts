import { parsePptx } from './pptx-parser.js';

interface LambdaEvent {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string } };
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  try {
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'リクエストボディが空です' }),
      };
    }

    const body = event.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body, 'base64').toString())
      : JSON.parse(event.body);

    const { file } = body as { file?: string };

    if (!file) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'file フィールド（Base64）が必要です' }),
      };
    }

    const buffer = Buffer.from(file, 'base64');
    const result = await parsePptx(buffer);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('PPTX parse error:', err);

    const message = err instanceof Error && err.message.includes('not a valid zip')
      ? '無効な PPTX ファイルです'
      : err instanceof Error
        ? err.message
        : 'Internal server error';

    return {
      statusCode: message === '無効な PPTX ファイルです' ? 400 : 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: message }),
    };
  }
}
