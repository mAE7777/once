# Once

Make anyone an expert in anything, in one read.

Once is a web app that explains a text aloud to someone with no background in it. It does not follow the author's order. It starts from the real-world situation, the problem and what people tried, then the answer and where it stops holding, using everyday examples. The original stays open, and the exact sentences behind each point light up as they are discussed.

Paste text, upload a PDF, image, `.txt` or `.md` file, or paste a link to an article. English texts only for now.

## Run it

Needs Node 24 or newer.

```sh
git clone https://github.com/mAE7777/once.git
cd once
npm install
npm run build
npm start
```

Open http://localhost:3000. Three prepared samples are in the library and need no keys. *Attention Is All You Need* includes voice for its opening and its first figure section.

## Add your own keys

Processing your own texts takes your own keys. Copy `.env.example` to `.env.local`, fill it in, and restart.

| Key | What it does | Without it |
|---|---|---|
| `META_API_KEY` | Reads and explains new texts, responds to answers, transcribes spoken answers, finds figure parts. Get one at [dev.meta.ai](https://dev.meta.ai). | Samples still work. A new text stops with a clear message. |
| `ELEVENLABS_API_KEY` | Speaks new explanations. | No voice for new texts; open the transcript on the right to read along. |

A new text takes several minutes, and the loading screen shows an estimate. Each text is processed once and reused after that.

## Using the reader

- Play, pause, previous and next section are at the top right. Each section stops and waits for you.
- The arrow on the right edge slides out the transcript.
- The speech bubble turns on questions. They appear at chosen moments; you can type or speak one answer.
- Underlined words open a short note.
- The page icon switches between the original and clean typeset pages.

## How the explanation is made

An engine in `src/deepread` handles any text in stages: understand the problem and the ideas a newcomer needs, research what the text takes for granted, outline sections, write them in parallel, check the result with a separate listener that hears only the narration, and repair what it could not follow. Every quote is proven word for word against the text before it can light up.

## Models

- `muse-spark-1.3`: reading, explaining, questions, reading scanned pages
- `sam-3.1`: lighting up parts of figures
- `muse-voice-transcribe-1.0`: spoken answers
- ElevenLabs: narration with a word timeline

## Development

```sh
npm test
npm run dev
```

## What comes next

Once is the same explanation for everyone today. The direction is an explanation that fits each person better the more they use it.

**Any language**
- Read texts in languages other than English.
- Learn in the language you choose: explanation, voice, questions and interface, with the original still lit up on the page.
- A translation you can keep beside the original.

**A live guide**
- A conversation instead of a prepared recording: interrupt, ask why, say what you already know, and the explanation changes with you.

**Explanations shaped to you**
- Personal accounts, so your reading stays yours and follows you across devices.
- A picture of what you already know, how you reason, and how you best take things in, so the order, the examples, the pace and the tone are chosen for you. People differ, so the path through a text should too.
- A short first test to predict where you will get stuck, and a default suited to you: being told, or working it out yourself.
- The voice and tone you prefer.

**Learning that compounds**
- A history of what you have read: what you understood, which words you earned, which misunderstandings were corrected.
- Feedback gathered as you read (where you pause, rewind or get a question wrong) feeding the next explanation, so it fits you more closely with every text.
- Connections across texts: "this has the same structure as something you read last month, and here is what differs", with the reason stated, never just a shared word.

**Better sources and figures**
- Stronger handling of scans, tables, equations and long books.
