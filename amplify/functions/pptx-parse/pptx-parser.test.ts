import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parsePptx, type ImageUploader } from './pptx-parser.js';

// PNG の最小バイト列（1x1 黒画素）
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
  'hex'
);

function slideXml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:nvPr/></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

function relsXml(
  relationships: Array<{ id: string; type: string; target: string }>
): string {
  const items = relationships
    .map(
      r =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
}

const IMAGE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

async function buildPptx(
  entries: Record<string, string | Buffer>
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return await zip.generateAsync({ type: 'nodebuffer' });
}

test('画像を含まないスライドは images を空配列で返す', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('Title1', 'Body1'),
  });
  const result = await parsePptx(buf);
  assert.equal(result.totalSlides, 1);
  assert.deepEqual(result.slides[0].images, []);
  assert.equal(result.slides[0].title, 'Title1');
  assert.equal(result.slides[0].body, 'Body1');
});

test('画像 1 枚を含むスライドは base64 bytes を返す', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
  });
  const result = await parsePptx(buf);
  assert.equal(result.slides[0].images.length, 1);
  const img = result.slides[0].images[0];
  assert.equal(img.index, 0);
  assert.equal(img.mediaType, 'image/png');
  assert.equal(img.bytes, MINIMAL_PNG.toString('base64'));
  assert.equal(img.presignedUrl, undefined);
});

test('複数画像は index が 0 起算で付与される', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
      { id: 'rId2', type: IMAGE_REL_TYPE, target: '../media/image2.jpg' },
      { id: 'rId3', type: IMAGE_REL_TYPE, target: '../media/image3.webp' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
    'ppt/media/image2.jpg': MINIMAL_PNG,
    'ppt/media/image3.webp': MINIMAL_PNG,
  });
  const result = await parsePptx(buf);
  const images = result.slides[0].images;
  assert.equal(images.length, 3);
  assert.deepEqual(
    images.map(i => i.index),
    [0, 1, 2]
  );
  assert.deepEqual(
    images.map(i => i.mediaType),
    ['image/png', 'image/jpeg', 'image/webp']
  );
});

test('非対応形式 (.emf/.wmf) はスキップされる', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
      { id: 'rId2', type: IMAGE_REL_TYPE, target: '../media/image2.emf' },
      { id: 'rId3', type: IMAGE_REL_TYPE, target: '../media/image3.wmf' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
    'ppt/media/image2.emf': Buffer.from('fake-emf'),
    'ppt/media/image3.wmf': Buffer.from('fake-wmf'),
  });
  const result = await parsePptx(buf);
  const images = result.slides[0].images;
  assert.equal(images.length, 1, 'png のみ抽出される');
  assert.equal(images[0].mediaType, 'image/png');
});

test('複数スライドの画像がスライドごとに分離される', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T1', 'B1'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
    ]),
    'ppt/slides/slide2.xml': slideXml('T2', 'B2'),
    'ppt/slides/_rels/slide2.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image2.png' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
    'ppt/media/image2.png': MINIMAL_PNG,
  });
  const result = await parsePptx(buf);
  assert.equal(result.totalSlides, 2);
  assert.equal(result.slides[0].images.length, 1);
  assert.equal(result.slides[1].images.length, 1);
});

test('合計サイズが上限超過時に imageUploader が呼ばれ presignedUrl が返る', async () => {
  // 閾値を小さくしてフォールバックを強制
  const threshold = 100; // 100 bytes
  const uploaderCalls: Array<{ slideNumber: number; index: number }> = [];
  const uploader: ImageUploader = async ({ slideNumber, index }) => {
    uploaderCalls.push({ slideNumber, index });
    return `https://example.com/presigned/slide${slideNumber}-${index}`;
  };

  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
      { id: 'rId2', type: IMAGE_REL_TYPE, target: '../media/image2.png' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
    'ppt/media/image2.png': MINIMAL_PNG,
  });

  const result = await parsePptx(buf, {
    imageUploader: uploader,
    maxInlineImageBytes: threshold,
  });

  assert.equal(uploaderCalls.length, 2);
  const images = result.slides[0].images;
  for (const img of images) {
    assert.equal(img.bytes, undefined, 'bytes は含まれない');
    assert.ok(img.presignedUrl?.startsWith('https://'), 'presignedUrl が設定される');
  }
});

test('上限超過時に uploader 未指定ならエラー', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
  });
  await assert.rejects(
    () => parsePptx(buf, { maxInlineImageBytes: 10 }),
    /imageUploader が設定されていないため/
  );
});

test('閾値以下ならフォールバックせず uploader は呼ばれない', async () => {
  let called = false;
  const uploader: ImageUploader = async () => {
    called = true;
    return 'url';
  };
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    'ppt/slides/_rels/slide1.xml.rels': relsXml([
      { id: 'rId1', type: IMAGE_REL_TYPE, target: '../media/image1.png' },
    ]),
    'ppt/media/image1.png': MINIMAL_PNG,
  });
  const result = await parsePptx(buf, { imageUploader: uploader });
  assert.equal(called, false);
  assert.ok(result.slides[0].images[0].bytes);
});

test('rels ファイルが存在しないスライドも空の images で処理される', async () => {
  const buf = await buildPptx({
    'ppt/slides/slide1.xml': slideXml('T', 'B'),
    // rels ファイルなし
  });
  const result = await parsePptx(buf);
  assert.deepEqual(result.slides[0].images, []);
});
