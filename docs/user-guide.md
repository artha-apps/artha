# Artha User Guide (for everyone)

A plain-English walkthrough for a **first-time, non-technical user** — from
installing Artha to getting your first finished document. No coding, no jargon.

> For the developer setup (git clone, `npm run dev`, native rebuilds) see
> [`getting-started.md`](./getting-started.md) instead. This guide is for the
> person who just wants to *use* the app.

---

## What Artha is (in one sentence)

**Artha is an AI assistant that lives on your own computer.** You type what you
want in plain English — *"write me a project proposal"*, *"summarize these 10
PDFs"* — and it does the work and hands you the finished file. **Nothing you type
or upload ever leaves your machine.** No account, no upload, no subscription.

That's the whole point: **privacy + no subscription**. Your contracts, finances,
and client documents stay on your computer, period.

---

## Step 0 — Install (2 clicks)

1. Go to the website and click **Download**. The button detects your computer
   (Mac / Windows / Linux) and gives you the right file.
2. Open it like any normal app — drag to Applications on a Mac, or run the
   installer on Windows.

> 💡 This is a real app you install once, like Zoom or Spotify — not a website
> you log into.

---

## Step 1 — First launch: the welcome screen

The first time you open Artha, a **Welcome screen** fills the window:

> *"Welcome to Artha. Let's get a local AI model running. This stays 100% on
> your machine."*

Artha needs an AI "brain" before it can do anything, so this screen walks you
through getting one. Three automatic checks happen:

### 1a. Is the engine installed? (Ollama)

Artha uses a free program called **Ollama** to run the AI locally.

- **If it's missing:** you'll see a friendly note — *"Ollama isn't running"* —
  with a **Download Ollama** button and a **Recheck** button. Install Ollama,
  come back, and click **Recheck**.
- **If it's already there:** Artha skips ahead automatically.

> 💡 Ollama is the free engine that runs the AI. Install it once and forget it.

### 1b. What can your computer handle?

Artha checks your computer's memory and shows something like:

> *"16 GB RAM detected · Recommended: a balanced model"*

It then **recommends the best AI model for your exact machine**, so you never
have to understand model names.

### 1c. Get the AI brain (download a model)

Click the one big button to **download the recommended model**. A progress bar
fills up live. This happens **once** — afterward it's permanent and works
**offline**.

- Already have models installed? Artha lists them — just click one.
- There's always a **"Skip — I'll set this up later"** option.
- Prefer a cloud model? You can add one anytime in **Settings → Models**.

Once a model is active, the welcome screen disappears for good.

> 💡 You're downloading the AI's brain to your computer. After this, it works
> with no internet.

---

## Step 2 — The main screen

Now you're in the app. There are three zones:

- **Left sidebar** — your chats (like conversations in ChatGPT), plus panels for
  Skills, Models, and Settings.
- **Center** — the chat window where you talk to Artha.
- **Composer box (bottom)** — where you type, and where you attach folders/files.

> 💡 It looks like a chat app on purpose. If you've used ChatGPT, you already
> know how to use this — except Artha can actually *make files and do tasks*,
> and it's *private*.

---

## Step 3 — Your first real task (the "aha" moment)

Type something concrete, for example:

> *"Write a one-page project proposal for a website redesign for a client called
> Acme."*

Artha runs a **plan → do → check** loop: it figures out the steps, does them,
double-checks its own work, and for document tasks produces a polished
**Word, PowerPoint, Excel, or PDF** file that opens in its native app. For big or
risky tasks, it can **show you its plan first and wait for your approval** before
acting.

> 💡 Don't just ask questions — ask for **deliverables**: *"Make me a…"*,
> *"Build me a…"*, *"Turn these into a…"*. That's where Artha is different from a
> normal chatbot.

---

## Step 4 — Working with your own files (scopes)

This is the feature that makes Artha useful for real work. In the composer you
can **attach a folder or specific files to a chat**. Once attached:

- Artha can **read and answer questions about those files** — *"what's in this
  folder?"*, *"summarize these contracts"*.
- It is **sandboxed**: it can *only* touch the folders/files you attached. It
  physically cannot reach anything else on your computer.
- Files it generates are **saved into that folder** automatically.

> 💡 Drag in the folder you're working on. Artha can only see what you give it —
> nothing else.

---

## Step 5 — Growing into the power features (later, optional)

You don't need any of this on day one. Discover it when you're ready:

| Feature | What it does for you |
|---|---|
| **Skills** (`/name`) | Save a repeatable instruction once, reuse it forever (e.g. `/weekly-report`). |
| **Memory** | Artha remembers useful facts about you and your projects across chats. |
| **Web search & browser** | It can look things up online and even click around a webpage while you watch. |
| **Scheduler** | *"Do this every Monday at 9am"* — runs tasks on a timer and notifies you. |
| **Add tools (MCP)** | Plug in extra capabilities from a built-in catalog, no coding required. |
| **Cloud accounts** (opt-in) | Connect Gmail / Calendar / Drive — only if you choose to. |
| **Team mode** | Share Artha and shared memory across people on your local network. |

---

## The mental model to remember

1. **Install once** — the app, the free Ollama engine, and one model download.
2. **Talk to it like a person**, but ask for finished *things*, not just answers.
3. **Give it a folder** when you want it to work on your real files — and trust
   that it can't see anything else.
4. **Everything stays on your computer.** No account, no upload, no subscription.
