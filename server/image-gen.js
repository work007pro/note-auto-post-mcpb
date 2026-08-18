/**
 * Gemini API (gemini-3.1-flash-image-preview) を使った画像生成。
 * ユーザーが Claude Desktop の拡張機能設定画面で入力した API キーを使用する。
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const MODEL = 'gemini-3.1-flash-image-preview';

/**
 * @param {object} opts
 * @param {string} opts.prompt - 画像生成プロンプト（日本語テキストを画像内に描く場合は明記する）
 * @param {string} opts.outputPath - 保存先の絶対パス
 * @param {string} opts.apiKey - Gemini APIキー
 * @param {"1:1"|"16:9"|"9:16"|"4:3"|"3:4"} [opts.aspectRatio]
 */
export async function generateImage({ prompt, outputPath, apiKey, aspectRatio = '16:9' }) {
  if (!apiKey) {
    throw new Error('Gemini APIキーが設定されていません。Claude Desktopの拡張機能設定からAPIキーを登録してください。');
  }
  if (!prompt || !outputPath) throw new Error('prompt と outputPath は必須です');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio, imageSize: '1K' },
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) {
    const textPart = parts.find((p) => p.text)?.text || '';
    throw new Error(`画像データが返されませんでした。${textPart ? 'モデル応答: ' + textPart.slice(0, 200) : JSON.stringify(data).slice(0, 300)}`);
  }

  const buf = Buffer.from(imagePart.inlineData.data, 'base64');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buf);

  return { outputPath, bytes: buf.length };
}
