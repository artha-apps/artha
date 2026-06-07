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

> 🖼️ **Prefer slides?** Open [`user-guide-slides.html`](./user-guide-slides.html)
> in any browser for a click-through tour of every feature (use `←` / `→`, press
> `F` for fullscreen, or `P` to save it as a PDF). It mirrors this guide
> one feature per slide.

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

## Step 5 — Growing into the power features

You don't need any of this on day one. When you're ready, **[Part 2 — Every
feature, step by step](#part-2--every-feature-step-by-step)** below walks through
each one with numbered steps and a "Try this" example you can paste straight into
a chat.

---

## The mental model to remember

1. **Install once** — the app, the free Ollama engine, and one model download.
2. **Talk to it like a person**, but ask for finished *things*, not just answers.
3. **Give it a folder** when you want it to work on your real files — and trust
   that it can't see anything else.
4. **Everything stays on your computer.** No account, no upload, no subscription.

---

# Part 2 — Every feature, step by step

Each feature below has a one-line *what it does*, **numbered steps**, and a
**Try this** prompt you can paste into a chat. Slide version:
[`user-guide-slides.html`](./user-guide-slides.html).

> Most of these also have an in-app guide: click the **?** on a Settings panel,
> or open **Settings → Guide** for the same walkthrough next to the controls.

## Everyday basics

### 💬 Chat with local AI
Talk to Artha in plain English — it runs entirely on your machine.
1. Check the **model chip** at the top shows a model (e.g. `qwen3.5`).
2. Type what you want in the box at the bottom.
3. Press **Enter** and watch it think and reply.

**Try this:** *Explain what an MCP server is in simple terms.*

### 🗂️ Get things done with your files
Ask Artha to move, organise, rename, or find files — it actually does it.
1. Ask in plain English what you want done.
2. Artha looks through the folder, then performs the changes.
3. It confirms what it moved or created when finished.

**Try this:** *Move today's screenshots on my Desktop into a folder called ss26.*

### 📄 Create documents
Generate Word, Excel, PowerPoint, and PDF files from a description.
1. Describe the document you want.
2. Artha writes it and saves the file locally.
3. Open it from the folder it tells you.

**Try this:** *Make a one-page PDF proposal for a small coffee shop.*

### 🔎 Chat with your own files (scopes)
Point Artha at a folder and ask questions — it answers and cites the files.
1. Click the **Folder** button next to the message box to attach a folder.
2. Ask a question about what's in it.
3. Artha answers and shows which files it used. It is sandboxed to exactly what
   you attached — nothing else.

**Try this:** *What did I decide in my meeting notes from last week?*

## Power features

### 🤝 Delegate a whole goal
Hand over a task and Artha acts on your behalf to finish it end-to-end.
1. Open the **Delegate** tab and type your goal in plain English.
2. Review the plan, then **approve** — a live progress timeline appears.
3. If a site needs a login, Artha **pauses and hands you the browser**; sign in,
   then it continues automatically.
4. Read the result and any files it produced when it finishes.

**Try this:** *Find the 3 cheapest direct flights NYC→London next month and put
them in a table.*

### 🌐 The agent browser
Artha drives a real Chromium tab you can watch — and you can take the wheel.
1. Ask Artha to use a website; the browser pane opens automatically.
2. Watch it navigate, click, and read pages live.
3. For a login, captcha, or 2FA it **hands you control** — finish the step, then
   click **Resume**.
4. Drag the divider to resize the chat ⇄ browser split.

**Try this:** *Open my bank's login page so I can sign in, then summarise my
latest statement.*

### 🔁 Workflows — save & replay
Turn any successful run into a repeatable workflow.
1. Run a multi-step task in Chat once and confirm it worked.
2. **Save it as a Workflow** from the run's menu.
3. Open the **Workflows** tab to replay it, or browse the **Runs / Activity**
   feed of everything Artha has done.

**Try this:** Save your "weekly competitor digest" run, then replay it every Monday.

### ⚡ Skills — slash playbooks
Named playbooks the agent picks automatically (research, writing, organizing…).
1. Type **`/`** in the chat composer to see all available skills.
2. Pick one (e.g. `/research`) or just describe your task — Artha auto-matches.
3. Click **+ New skill** to write your own: a slug, instructions, and the tools
   it may use.

**Try this:** */research summarize the top AI news today*

### 📚 RAG — chat with a whole folder
Give the agent searchable access to a folder — no cloud, no upload.
1. In **Settings → RAG**, click **+ New index** and pick a folder.
2. Wait for the index to build (seconds for small folders, minutes for large).
3. In a chat, type **`/ask`** a question — the agent searches and cites the files.
   Re-indexing only touches files that changed.

**Try this:** */ask what are the payment terms across all my contracts?*

### 🧩 Memory — it remembers you
Long-term facts the agent keeps across every conversation.
1. In any chat, say *"Remember that my preferred document style is APA."*
2. Open **Settings → Memory** to see, pin, edit, or delete what it stored.
3. Start a new chat and ask *"What's my preferred document style?"* — it knows.

## Models

### 🧮 Pick & route your models
Choose which local model powers Artha, and send different work to different models.
1. Click the **model chip** → **Settings → Models** to pick or download a model.
2. In **Settings → Router**, add rules like *"code → llama3.1:70b"*, *"everything
   else → llama3.2:3b"*.
3. Send a chat — the chosen model appears in the execution log. Smaller = faster,
   bigger = smarter.

## Connect the world

### 🔌 MCP tools & Marketplace
Plug external tools into the agent (Slack, GitHub, Postgres…) or install curated
skill packs.
1. Open **Settings → Marketplace** and browse the curated list.
2. Pick a server or skill pack and click **Install** — it sets everything up.
3. Toggle it on; the agent can use those tools/playbooks in any chat. (MCP adds
   raw capabilities; the Marketplace adds ready-made playbooks.)

**Try this:** Install the GitHub MCP server, then: *open a PR with my latest changes.*

### ☁️ Cloud integrations
Bring in your Google, Notion, GitHub, and other accounts. Tokens stay on your
machine.
1. In **Settings → Cloud Integrations**, pick a service (e.g. Google Drive).
2. Sign in through the browser window that opens (a one-time login).
3. Ask *"What files do I have in Drive?"* — revoke any time to forget the token.

### 👥 CRM + knowledge graph
A local CRM of companies and contacts, linked in a knowledge graph the agent can
reason over.
1. Ask Artha to add or look up people and companies; entries appear in
   **Settings → CRM**.
2. It links related entities so it can answer relationship questions.
3. Combine with research: it can find facts on the web and file them into your CRM.

**Try this:** *Research our top 3 competitors and add each as a company in my CRM.*

## Automate

### ⏰ Scheduler — recurring tasks
Run a task on a schedule, or get proactive briefings prepared before you ask.
1. Open **Settings → Scheduler** and create a job from a task or saved workflow.
2. Choose when it runs (e.g. every weekday at 8am).
3. Artha runs it in the background and notifies you with the result.

**Try this:** *Every Monday 8am: summarise last week's sales emails.*

## Trust & control

### 🛡️ Policies, impact preview & receipts
Stay in control of every action — set rules, preview impact, audit the trail.
1. **Settings → Tool Policies:** set each tool to **Auto**, **Confirm**,
   **Dry-run**, or **Forbid** (Artha asks before deleting files by default).
2. On an approval card, read the **Estimated impact** chips — deletions, web
   access, reversibility, rough cost — then approve or cancel.
3. After a run, open **Run details** (or **Workflows → Runs**) to see
   **receipts**: what happened, content hashes, and anything a policy blocked.

**Try this:** *Organise my Downloads folder by file type* — then check the receipts.

### 🖱️ Desktop control (opt-in)
Let Artha move the real mouse/keyboard to operate any app — clearly indicated.
1. Enable it in **Settings → Desktop Control** (off by default).
2. Ask for a task that needs a non-web app; a glowing **"Artha is in control"**
   overlay shows while it acts.
3. Move your mouse or stop the run any time to take back control.

## Team & Pro

### 📶 Share over your network — *Pro*
Run Artha as a server on your local network so teammates can reach the same agent.
1. Apply a **Pro/Enterprise license**, then open **Settings → Team / LAN Server**.
2. Create at least one **API key** (the server refuses to start without auth).
3. **Start the server** and share the LAN URL + key with your teammates.

### 🔑 Unlock Pro
Pro is a one-time purchase — buy once, your key never expires.
1. Buy Pro at **artha.space** — your license key is emailed to you.
2. Open **Settings → License** and paste the key.
3. Pro features unlock immediately; the key stays on your machine.
