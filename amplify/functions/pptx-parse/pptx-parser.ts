import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export interface SlideData {
  slideNumber: number;
  title: string;
  body: string;
  notes: string;
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

    slides.push({ slideNumber: slideNum, title, body, notes });
  }

  return { totalSlides: slides.length, slides };
}
