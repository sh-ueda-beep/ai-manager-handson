import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export interface SlideImage {
  index: number;
  mediaType: string;
  bytes?: string;
  presignedUrl?: string;
}

export interface SlideData {
  slideNumber: number;
  title: string;
  body: string;
  notes: string;
  images: SlideImage[];
}

export interface ParseResult {
  totalSlides: number;
  slides: SlideData[];
}

export type ImageUploader = (args: {
  bytes: Buffer;
  mediaType: string;
  slideNumber: number;
  index: number;
}) => Promise<string>;

export interface ParsePptxOptions {
  imageUploader?: ImageUploader;
  maxInlineImageBytes?: number;
}

const DEFAULT_MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const SUPPORTED_IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// <a:t> タグからテキストを再帰的に抽出
function extractTextNodes(obj: unknown): string[] {
  const texts: string[] = [];
  if (obj == null) return texts;

  if (typeof obj === 'string') return [obj];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      texts.push(...extractTextNodes(item));
    }
    return texts;
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    if ('a:t' in record) {
      const t = record['a:t'];
      if (typeof t === 'string') {
        texts.push(t);
      } else if (typeof t === 'number') {
        texts.push(String(t));
      } else {
        texts.push(...extractTextNodes(t));
      }
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'object' && value !== null) {
        texts.push(...extractTextNodes(value));
      }
    }
  }
  return texts;
}

// シェイプがタイトル要素かどうかを判定
function isTitleShape(sp: Record<string, unknown>): boolean {
  const nvSpPr = sp['p:nvSpPr'] as Record<string, unknown> | undefined;
  if (!nvSpPr) return false;

  const nvPr = nvSpPr['p:nvPr'] as Record<string, unknown> | undefined;
  if (!nvPr) return false;

  const ph = nvPr['p:ph'] as Record<string, unknown> | undefined;
  if (!ph) return false;

  const type = ph['@_type'] as string | undefined;
  return type === 'title' || type === 'ctrTitle';
}

// スライド XML からタイトルと本文を抽出
function parseSlideXml(xml: string): { title: string; body: string } {
  const parsed = xmlParser.parse(xml);
  const sld = parsed['p:sld'] as Record<string, unknown> | undefined;
  if (!sld) return { title: '', body: '' };

  const cSld = sld['p:cSld'] as Record<string, unknown> | undefined;
  if (!cSld) return { title: '', body: '' };

  const spTree = cSld['p:spTree'] as Record<string, unknown> | undefined;
  if (!spTree) return { title: '', body: '' };

  let shapes = spTree['p:sp'];
  if (!shapes) return { title: '', body: '' };
  if (!Array.isArray(shapes)) shapes = [shapes];

  const titleTexts: string[] = [];
  const bodyTexts: string[] = [];

  for (const sp of shapes as Record<string, unknown>[]) {
    const texts = extractTextNodes(sp['p:txBody']);
    if (texts.length === 0) continue;

    if (isTitleShape(sp)) {
      titleTexts.push(...texts);
    } else {
      bodyTexts.push(...texts);
    }
  }

  return {
    title: titleTexts.join(' '),
    body: bodyTexts.join('\n'),
  };
}

// ノートスライド XML からテキストを抽出
function parseNotesXml(xml: string): string {
  const parsed = xmlParser.parse(xml);
  const notes = parsed['p:notes'] as Record<string, unknown> | undefined;
  if (!notes) return '';

  const cSld = notes['p:cSld'] as Record<string, unknown> | undefined;
  if (!cSld) return '';

  const spTree = cSld['p:spTree'] as Record<string, unknown> | undefined;
  if (!spTree) return '';

  let shapes = spTree['p:sp'];
  if (!shapes) return '';
  if (!Array.isArray(shapes)) shapes = [shapes];

  const texts: string[] = [];
  for (const sp of shapes as Record<string, unknown>[]) {
    // ノート本文のテキストボディからのみ抽出（スライド番号等を除外）
    const nvSpPr = sp['p:nvSpPr'] as Record<string, unknown> | undefined;
    const nvPr = nvSpPr?.['p:nvPr'] as Record<string, unknown> | undefined;
    const ph = nvPr?.['p:ph'] as Record<string, unknown> | undefined;
    const type = ph?.['@_type'] as string | undefined;

    if (type === 'body') {
      texts.push(...extractTextNodes(sp['p:txBody']));
    }
  }

  return texts.join('\n');
}

// slide の rels XML から画像ターゲット（ppt/media/imageN.ext 形式）を抽出
function parseSlideRelsForImages(xml: string): string[] {
  const parsed = xmlParser.parse(xml);
  const relationships = parsed['Relationships'] as Record<string, unknown> | undefined;
  if (!relationships) return [];

  let rels = relationships['Relationship'];
  if (!rels) return [];
  if (!Array.isArray(rels)) rels = [rels];

  const targets: string[] = [];
  for (const rel of rels as Record<string, unknown>[]) {
    const type = rel['@_Type'] as string | undefined;
    const target = rel['@_Target'] as string | undefined;
    if (!type || !target) continue;
    // image relationship type: /image で終わる（例: .../relationships/image）
    if (type.endsWith('/image')) {
      targets.push(target);
    }
  }
  return targets;
}

// `../media/image1.png` 等のターゲットを ZIP 内の絶対パスに正規化
function resolveMediaPath(target: string): string {
  // slide rels のベースは ppt/slides/_rels なので、../media/... → ppt/media/...
  const normalized = target.replace(/^(\.\.\/)+/, '');
  if (normalized.startsWith('ppt/')) return normalized;
  return `ppt/${normalized}`;
}

function getExtension(path: string): string {
  const match = path.match(/\.([^./\\]+)$/);
  return match ? match[1].toLowerCase() : '';
}

export async function parsePptx(
  buffer: Buffer,
  options: ParsePptxOptions = {}
): Promise<ParseResult> {
  const { imageUploader, maxInlineImageBytes = DEFAULT_MAX_INLINE_IMAGE_BYTES } = options;
  const zip = await JSZip.loadAsync(buffer);

  // スライドファイルを番号順にソート
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)![1]);
      const numB = parseInt(b.match(/slide(\d+)/)![1]);
      return numA - numB;
    });

  // Pass 1: テキスト・ノート抽出と、画像候補のバイナリ収集（サイズ判定のため先に全件読む）
  type PendingImage = {
    slideNumber: number;
    index: number;
    mediaType: string;
    buffer: Buffer;
  };

  const slidesIntermediate: Array<{
    slideNumber: number;
    title: string;
    body: string;
    notes: string;
    images: PendingImage[];
  }> = [];
  let totalImageBytes = 0;

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)![1]);
    const slideXml = await zip.files[slideFile].async('string');
    const { title, body } = parseSlideXml(slideXml);

    const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    let notes = '';
    if (zip.files[notesFile]) {
      const notesXml = await zip.files[notesFile].async('string');
      notes = parseNotesXml(notesXml);
    }

    // 画像抽出: slide rels を読み、該当画像だけを収集
    const relsFile = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
    const pendingImages: PendingImage[] = [];
    if (zip.files[relsFile]) {
      const relsXml = await zip.files[relsFile].async('string');
      const targets = parseSlideRelsForImages(relsXml);

      let localIndex = 0;
      for (const target of targets) {
        const mediaPath = resolveMediaPath(target);
        const ext = getExtension(mediaPath);
        const mediaType = SUPPORTED_IMAGE_EXTENSIONS[ext];
        if (!mediaType) {
          console.warn(
            `[pptx-parse] slide ${slideNum}: 非対応画像形式をスキップ (${mediaPath})`
          );
          continue;
        }
        const entry = zip.files[mediaPath];
        if (!entry) {
          console.warn(
            `[pptx-parse] slide ${slideNum}: 画像ファイルが見つかりません (${mediaPath})`
          );
          continue;
        }
        const bytes = await entry.async('nodebuffer');
        pendingImages.push({
          slideNumber: slideNum,
          index: localIndex,
          mediaType,
          buffer: bytes,
        });
        totalImageBytes += bytes.length;
        localIndex += 1;
      }
    }

    slidesIntermediate.push({
      slideNumber: slideNum,
      title,
      body,
      notes,
      images: pendingImages,
    });
  }

  // Pass 2: しきい値判定とレスポンス画像の組み立て。bytes と presignedUrl は混在させない
  const needsFallback = totalImageBytes > maxInlineImageBytes;
  if (needsFallback && !imageUploader) {
    throw new Error(
      `抽出画像の合計サイズが上限 ${maxInlineImageBytes} バイトを超えていますが、` +
        'imageUploader が設定されていないためフォールバックを実行できません'
    );
  }

  const slides: SlideData[] = [];
  for (const s of slidesIntermediate) {
    const images: SlideImage[] = [];
    for (const img of s.images) {
      if (needsFallback) {
        const presignedUrl = await imageUploader!({
          bytes: img.buffer,
          mediaType: img.mediaType,
          slideNumber: img.slideNumber,
          index: img.index,
        });
        images.push({ index: img.index, mediaType: img.mediaType, presignedUrl });
      } else {
        images.push({
          index: img.index,
          mediaType: img.mediaType,
          bytes: img.buffer.toString('base64'),
        });
      }
    }
    slides.push({
      slideNumber: s.slideNumber,
      title: s.title,
      body: s.body,
      notes: s.notes,
      images,
    });
  }

  return { totalSlides: slides.length, slides };
}
