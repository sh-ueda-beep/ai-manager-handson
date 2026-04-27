import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export interface SlideImage {
  mediaType: string;
  data: string;
}

export interface SlideData {
  slideNumber: number;
  title: string;
  body: string;
  notes: string;
  images: SlideImage[];
  imagesTruncated: boolean;
}

export interface ParseResult {
  totalSlides: number;
  slides: SlideData[];
}

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

const MAX_IMAGES_PER_SLIDE = 3;
const MAX_IMAGE_BASE64_BYTES = 1024 * 1024; // 1MB

// _rels ファイルから画像リレーションのZIPパスを返す
// OOXML仕様: 相対パスの基点は _rels/ の親ディレクトリ（_rels/ 自体ではない）
async function parseSlideRels(zip: JSZip, slideFile: string): Promise<string[]> {
  const relsFilePath = slideFile.replace(/^(ppt\/slides\/)(slide\d+\.xml)$/, '$1_rels/$2.rels');
  const relsEntry = zip.files[relsFilePath];
  if (!relsEntry) return [];

  const relsXml = await relsEntry.async('string');
  const parsed = xmlParser.parse(relsXml) as Record<string, unknown>;
  const rels = parsed['Relationships'] as Record<string, unknown> | undefined;
  if (!rels) return [];

  let relationships = rels['Relationship'];
  if (!relationships) return [];
  if (!Array.isArray(relationships)) relationships = [relationships];

  // _rels/ の親ディレクトリを基点にパスを解決する
  const relsDir = relsFilePath.replace(/\/_rels\/[^/]+$/, '/');

  const imagePaths: string[] = [];
  for (const rel of relationships as Record<string, unknown>[]) {
    const type = rel['@_Type'] as string | undefined;
    const target = rel['@_Target'] as string | undefined;
    if (!type?.endsWith('/image') || !target) continue;

    const resolved = relsDir + target.replace(/^\.\//, '');
    // パスを正規化（../ を解決）
    const parts = resolved.split('/');
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === '..') normalized.pop();
      else if (part !== '.') normalized.push(part);
    }
    imagePaths.push(normalized.join('/'));
  }

  return imagePaths;
}

// ZIPパスから画像をBase64エンコードして返す
async function extractImages(zip: JSZip, imagePaths: string[]): Promise<{ images: SlideImage[]; imagesTruncated: boolean }> {
  const images: SlideImage[] = [];
  let imagesTruncated = false;

  for (const imgPath of imagePaths) {
    if (images.length >= MAX_IMAGES_PER_SLIDE) {
      imagesTruncated = true;
      break;
    }

    const entry = zip.files[imgPath];
    if (!entry) {
      console.warn(`[pptx-parser] image not found in ZIP: ${imgPath}`);
      continue;
    }

    const ext = imgPath.split('.').pop()?.toLowerCase();
    const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : null;
    if (!mediaType) continue;

    const arrayBuffer = await entry.async('arraybuffer');
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    if (base64.length > MAX_IMAGE_BASE64_BYTES) {
      console.warn(`[pptx-parser] image too large, skipping: ${imgPath} (${base64.length} bytes)`);
      imagesTruncated = true;
      continue;
    }

    images.push({ mediaType, data: base64 });
  }

  return { images, imagesTruncated };
}

export async function parsePptx(buffer: Buffer): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(buffer);

  // スライドファイルを番号順にソート
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)![1]);
      const numB = parseInt(b.match(/slide(\d+)/)![1]);
      return numA - numB;
    });

  const slides: SlideData[] = [];

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)![1]);
    const slideXml = await zip.files[slideFile].async('string');
    const { title, body } = parseSlideXml(slideXml);

    // 対応するノートファイルを探す
    const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    let notes = '';
    if (zip.files[notesFile]) {
      const notesXml = await zip.files[notesFile].async('string');
      notes = parseNotesXml(notesXml);
    }

    // スライドに埋め込まれた画像を抽出する
    const imagePaths = await parseSlideRels(zip, slideFile);
    const { images, imagesTruncated } = await extractImages(zip, imagePaths);

    slides.push({ slideNumber: slideNum, title, body, notes, images, imagesTruncated });
  }

  return { totalSlides: slides.length, slides };
}
