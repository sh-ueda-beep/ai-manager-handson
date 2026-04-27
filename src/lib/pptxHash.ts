/**
 * PPTX の内容を一意に識別するためのハッシュ算出ユーティリティ。
 * Web Crypto API の SHA-256 を使い、先頭 12 文字（48 bit 相当）を返す。
 *
 * 信頼性検証用ではなく、同一 PPTX の重複登録判定用なので短縮ハッシュで十分。
 * 実運用規模（数万ファイル程度）では衝突確率はほぼ 0。
 */
export async function computePptxHash(source: File | ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = await toArrayBuffer(source)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return toHexPrefix(digest, 12)
}

async function toArrayBuffer(source: File | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return source
  if (source instanceof Uint8Array) {
    const sliced = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    )
    return sliced as ArrayBuffer
  }
  return await source.arrayBuffer()
}

function toHexPrefix(digest: ArrayBuffer, hexChars: number): string {
  const bytes = new Uint8Array(digest)
  const neededBytes = Math.ceil(hexChars / 2)
  let hex = ''
  for (let i = 0; i < neededBytes; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex.slice(0, hexChars)
}
