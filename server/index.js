#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { mkdirSync } from 'fs';
import { checkLoginStatus, startLogin, postToNote } from './note-poster.js';
import { generateImage } from './image-gen.js';

const OUTPUT_DIR = resolve(homedir(), '.note-auto-post-mcpb', 'images');
mkdirSync(OUTPUT_DIR, { recursive: true });

const server = new McpServer({
  name: 'note-auto-post',
  version: '1.0.0',
});

server.registerTool(
  'note_login',
  {
    title: 'note.comにログイン',
    description:
      'note.comへのログイン状態を確認する。未ログインならブラウザウィンドウを開くので、そこでユーザーに直接ログインしてもらう（メールアドレス・パスワードはこのツールには渡さない）。一度ログインすればセッションは保存され、次回以降は自動的にログイン済み扱いになる。post_to_note を初めて使う前に必ず一度呼び出すこと。',
    inputSchema: {},
  },
  async () => {
    const result = await startLogin();
    const text = result.alreadyLoggedIn
      ? '✅ 既にnote.comにログイン済みです。'
      : result.loginSucceeded
      ? '✅ ログインに成功しました。以後のpost_to_noteでこのセッションを使用します。'
      : '⚠️ ログインが確認できないまま時間切れになりました。もう一度 note_login を呼び出してください。';
    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'check_note_login',
  {
    title: 'note.comのログイン状態を確認',
    description: 'note.comに現在ログイン済みかどうかだけを確認する（ブラウザは開かない）。',
    inputSchema: {},
  },
  async () => {
    const loggedIn = await checkLoginStatus();
    return {
      content: [
        { type: 'text', text: loggedIn ? '✅ ログイン済みです。' : '❌ 未ログインです。note_login を呼び出してください。' },
      ],
    };
  }
);

server.registerTool(
  'generate_image',
  {
    title: '記事用の画像を生成',
    description:
      'note記事のサムネイルや本文図解をGemini画像生成APIで作成し、ローカルファイルとして保存する。日本語のテキストを画像内に入れたい場合は、プロンプトに「日本語で『◯◯』という文字を大きく入れる」のように明記すること。',
    inputSchema: {
      prompt: z.string().describe('画像生成プロンプト。画像の内容・構図・雰囲気・（必要なら）日本語テキストを具体的に指定する'),
      file_name: z.string().describe('保存するファイル名（例: thumbnail.png, fig1.png）。拡張子は.png'),
      aspect_ratio: z.enum(['16:9', '1:1', '9:16', '4:3', '3:4']).default('16:9').describe('サムネイルは16:9推奨'),
    },
  },
  async ({ prompt, file_name, aspect_ratio }) => {
    const outputPath = resolve(OUTPUT_DIR, file_name);
    try {
      const result = await generateImage({ prompt, outputPath, apiKey: process.env.GEMINI_API_KEY, aspectRatio: aspect_ratio });
      return {
        content: [
          {
            type: 'text',
            text: `✅ 画像を生成しました: ${result.outputPath} (${Math.round(result.bytes / 1024)}KB)\nこのパスをpost_to_noteのthumbnail_pathやbody内の![](パス)で使用してください。`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `❌ 画像生成に失敗しました: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'post_to_note',
  {
    title: 'note.comに下書きとして投稿',
    description:
      '記事のタイトルと本文をnote.comに下書きとして保存する。事前に note_login でログイン済みである必要がある。' +
      '本文は簡易Markdown記法（## 見出し／### 小見出し／- 箇条書き／> 引用／**太字**／![](画像パス)）に対応。' +
      '画像はgenerate_imageで生成したファイルの絶対パスを指定する。タグ・マガジン・予約投稿はこのツールでは設定しない' +
      '（下書き保存後、note.comの画面でユーザー自身が設定する）。',
    inputSchema: {
      title: z.string().describe('記事タイトル（日付や連番のプレフィックスは付けない）'),
      body: z.string().describe('記事本文。## 見出し・### 小見出し・- 箇条書き・> 引用・**太字**・![](画像の絶対パス) が使える'),
      thumbnail_path: z.string().optional().describe('サムネイル画像の絶対パス（generate_imageの出力を指定）'),
    },
  },
  async ({ title, body, thumbnail_path }) => {
    try {
      const result = await postToNote({ title, body, thumbnailPath: thumbnail_path, imagesDir: OUTPUT_DIR });
      const lines = [
        result.saved ? '✅ note.comに下書きとして保存しました。' : '⚠️ 下書き保存ボタンが見つからず、保存できていない可能性があります。',
        thumbnail_path ? (result.thumbnailOk ? '✅ サムネイル設定OK' : '⚠️ サムネイル設定に失敗しました') : null,
        result.failedImages?.length ? `⚠️ 挿入できなかった画像: ${result.failedImages.join(', ')}` : null,
        `編集URL: ${result.editorUrl}`,
        'タグ・マガジン・予約投稿はnote.comの画面から設定してください。',
      ].filter(Boolean);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `❌ 投稿に失敗しました: ${e.message}` }], isError: true };
    }
  }
);

server.registerPrompt(
  'note-draft',
  {
    title: 'note記事を書いて下書き投稿する',
    description: 'テーマを伝えると、リサーチ・執筆・画像生成・note.comへの下書き保存までを順番に進めます。',
    argsSchema: {
      theme: z.string().describe('記事のテーマ（例: 「ChatGPTで家計簿を自動化する方法」）'),
    },
  },
  ({ theme }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `あなたはnote.com向けの記事作成を手伝います。以下の手順を順番に、省略せずに進めてください。

テーマ: ${theme}

【手順】
1. まず note_login ツールを呼び、note.comにログイン済みか確認する（未ログインならブラウザが開くのでユーザーに待つよう伝える）。
2. テーマについて、あなたの知識（および使えるならweb検索）でリサーチする。初心者がつまずきそうなポイント・具体的な数字や手順を意識する。
3. 記事を執筆する。
   - 3000字以上
   - 冒頭3行で「読者の悩み→この記事で得られること→根拠」を簡潔に示す
   - H2見出し（##）を4つ以上、必要に応じてH3（###）
   - スマホで読みやすいよう1段落2〜3文程度、こまめに改行
   - 出典URLや宣伝文句は本文に書かない
4. generate_image ツールで、サムネイル画像を1枚（file_name例: thumbnail.png、日本語タイトルの核心を大きく入れる）、本文用の図解を1〜2枚生成する。
5. 生成した画像を本文の適切な位置に ![](絶対パス) の形で挿入する。
6. post_to_note ツールで、タイトル・本文・サムネイルパスを渡して下書き保存する。
7. 完了したら、保存されたnote.comの編集URLをユーザーに伝え、「タグの追加・予約投稿の設定はnote.comの画面から行ってください」と案内する。

途中で失敗した場合は、正直に失敗内容を伝え、どこからやり直すべきか提案してください。`,
        },
      },
    ],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('note-auto-post MCP server: running on stdio');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
