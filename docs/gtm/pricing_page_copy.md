# Artha Pricing Page Copy

> **Usage note:** This file contains production-ready copy for the Artha pricing page. Each section maps to a UI tier card. CTAs are labeled for implementation. Tone is confident, honest, and technical-but-human — written for privacy-conscious professionals who are skeptical of AI hype and vendor lock-in.

---

## Page Header

### Headline
**Your AI. Your machine. Your rules.**

### Subheadline
Artha runs entirely on your device. No cloud required, no data leaving your desk, no AI company reading your files. Start free — upgrade when you need more.

---

## Trust Bar (below headline, before tier cards)

> No data collection by default &nbsp;|&nbsp; Local SQLite database &nbsp;|&nbsp; Works offline &nbsp;|&nbsp; Open file formats &nbsp;|&nbsp; GDPR & CCPA aligned

---

## Tier Cards

---

### Tier 1: Free

**Badge:** Free — Forever

**Hero Statement:**
The full power of local AI, no strings attached.

Artha Free gives you a complete local AI agent that runs on your hardware. Your conversations, documents, and agent memories stay in a SQLite database on your device. We don't see them. Neither does anyone else.

**Includes:**
- Unlimited local AI conversations via Ollama (Llama, Mistral, Phi, and more)
- Local document indexing — import PDFs, Markdown, text files
- Persistent agent memory — Artha remembers context across sessions
- Basic agent skills — research, summarize, draft, extract
- Full SQLite data export at any time — your data is always portable
- Works completely offline
- No account required

**Who it's for:**
Developers, researchers, and privacy-conscious professionals who want powerful local AI without a subscription or a privacy compromise.

**CTA Label:** Download Free — No Account Needed

---

### Tier 2: Pro

**Badge:** Pro — $20/month (or $192/year, save 20%)

**Hero Statement:**
Local-first AI that follows you across devices — and stays yours.

Pro adds encrypted multi-device sync and advanced skills to everything in Free. Your data is encrypted on your device before it ever touches our servers. We literally cannot read it.

**Includes everything in Free, plus:**
- End-to-end encrypted cloud sync across your devices (AES-256, client-side)
- Advanced agent skills: web research, code execution, calendar integration
- Bring Your Own Key (BYOK) — connect OpenAI, Anthropic, or Gemini with your own API key; queries go device-to-provider, never through us
- Priority email support with 48-hour response guarantee
- Early access to new features and beta skills
- Artha Pro badge (for the flex, honestly)

**Privacy note on sync:** When sync is enabled, we store encrypted blobs we cannot decrypt. Disable sync anytime and your data returns to being purely local. No lock-in.

**Who it's for:**
Knowledge workers, consultants, lawyers, and analysts who work across multiple machines and want AI that is both capable and genuinely private.

**CTA Label:** Start Pro — 14-Day Money-Back Guarantee

---

### Tier 3: Team

**Badge:** Team — $15/seat/month (minimum 3 seats, billed annually)

**Hero Statement:**
Private AI for your whole team — without IT nightmares or compliance panic.

Team gives every member a full Pro experience plus shared workspaces, team-level administration, and the controls your compliance team will actually approve. Data stays local unless your team explicitly enables shared features.

**Includes everything in Pro, plus:**
- Shared workspaces with team-scoped document libraries
- Centralized team admin — add/remove members, manage access levels
- Unified billing and seat management from a single dashboard
- Team-level audit log — know who ran what, without reading their conversations
- Shared skills library — build a skill once, deploy to the whole team
- SSO / SAML integration [PLACEHOLDER: available Q3]
- Dedicated onboarding session (1 hour with the Artha team)
- Volume discounts available for 25+ seats — contact us

**For regulated industries:**
Artha's local-first architecture means no patient data, case files, or financial records need to leave your firm's machines. Our Team tier is designed to be the AI tool your compliance officer can approve.

**Who it's for:**
Law firms, financial advisory teams, healthcare groups, and any organization where data sovereignty and auditability matter.

**CTA Label:** Start Team Trial — 14 Days Free

---

### Tier 4: Enterprise

**Badge:** Enterprise — Custom Pricing

**Hero Statement:**
When your compliance requirements are the spec, not an afterthought.

Enterprise gives large organizations, government agencies, and regulated enterprises a fully customized Artha deployment — on your infrastructure, under your security controls, with contractual commitments to match.

**Everything in Team, plus:**
- On-premises or private-cloud deployment option (your servers, full control)
- Custom data residency — specify the geography where any cloud components operate
- SOC 2 Type II report sharing (in progress — contact us for current status)
- BAA (Business Associate Agreement) available for HIPAA-covered entities
- DPA (Data Processing Agreement) for GDPR Article 28 compliance
- Custom SLA with uptime commitments and escalation paths
- Dedicated account manager and customer success engineer
- Priority security review and custom penetration test coordination
- Annual contract pricing with flexible payment terms
- Custom skill development and integration work available

**CTA Label:** Talk to Our Enterprise Team

**Sub-CTA:** [Book a 30-minute call] — no sales deck, just an honest conversation about your requirements.

---

## Feature Comparison Table

| Feature | Free | Pro | Team | Enterprise |
|---|:---:|:---:|:---:|:---:|
| Local AI inference (Ollama) | Yes | Yes | Yes | Yes |
| Local SQLite storage | Yes | Yes | Yes | Yes |
| Works offline | Yes | Yes | Yes | Yes |
| No account required | Yes | — | — | — |
| Data export (JSON / SQLite) | Yes | Yes | Yes | Yes |
| End-to-end encrypted sync | — | Yes | Yes | Yes |
| BYOK cloud model support | — | Yes | Yes | Yes |
| Advanced agent skills | — | Yes | Yes | Yes |
| Shared team workspaces | — | — | Yes | Yes |
| Team admin & audit log | — | — | Yes | Yes |
| Shared skills library | — | — | Yes | Yes |
| SSO / SAML | — | — | Coming | Yes |
| On-premises deployment | — | — | — | Yes |
| BAA / DPA / SLA | — | — | — | Yes |
| Dedicated support | — | Email | Email + Onboarding | Dedicated CSM |

---

## FAQ Section

**Q: What happens to my data if I cancel?**
Nothing bad. Your local SQLite database stays on your device exactly as it was. If you had sync enabled, you can export your cloud data before cancellation, and we delete it within 30 days. You never lose access to your own files.

**Q: Can I use Artha completely offline?**
Yes. Artha Free works with zero internet connectivity. The app, your data, and your AI models all run locally. (Pro sync obviously requires connectivity when syncing, but local features work offline.)

**Q: What models does Artha support?**
Any model compatible with Ollama — Llama 3, Mistral, Phi-3, Gemma 2, Qwen, DeepSeek, and dozens more. Pro users can also connect cloud models (GPT-4o, Claude, Gemini) via their own API keys.

**Q: Is my data used to train AI models?**
No. We have no access to your local data. For Pro sync, your data is encrypted client-side — we cannot read it. We do not use any user data to train models, ever.

**Q: Do you offer discounts for nonprofits or academic institutions?**
Yes. Contact us at [PLACEHOLDER: billing@artha.app] with your organization details. We offer 50% off Pro for verified nonprofits and academic researchers.

**Q: What does "local-first" actually mean?**
It means the application is designed so that local operation is the primary, full-featured mode — not a stripped-down offline fallback. Cloud features are additive enhancements, never prerequisites for core functionality.

**Q: I work in healthcare / legal / finance. Can my firm use this?**
Yes — Artha was designed with regulated industries in mind. The local-first architecture means sensitive client data can stay on your firm's devices by default. Enterprise customers can sign a BAA (for HIPAA) or DPA (for GDPR). Talk to us about your specific requirements.

---

## Social Proof Callouts

> "The first AI tool my firm's compliance team didn't immediately flag." — [PLACEHOLDER: Customer quote, legal sector]

> "I've been waiting for an AI assistant that doesn't require me to trust a cloud vendor with client data. Artha is it." — [PLACEHOLDER: Customer quote, financial services]

> "Runs on my air-gapped dev machine. Exactly what I needed." — [PLACEHOLDER: Customer quote, security researcher]

---

## Bottom CTA Section

### Headline
Start local. Stay in control.

### Body
Download Artha free today — no account, no trial timer, no credit card. If you decide you want more, upgrading takes 60 seconds.

### Primary CTA
**Download for macOS / Windows / Linux**

### Secondary CTA
**Compare all features** | **Talk to Sales** | **Read the Privacy Policy**

---

*Prices listed in USD. Annual plan pricing shown where applicable. All plans include access to Artha's open file formats — your data is never locked in.*
