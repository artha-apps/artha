# Artha Privacy Policy

**Effective Date:** [PLACEHOLDER: Insert Date]
**Last Updated:** [PLACEHOLDER: Insert Date]

---

## 1. Introduction and Our Core Commitment

Artha is a local-first AI agent desktop application. This Privacy Policy describes how Artha ("we," "us," or "our") handles information in connection with your use of the Artha desktop application and any associated services (collectively, the "Service").

**Our fundamental privacy commitment is this: by default, Artha does not collect, transmit, or have access to any of your data.** Your conversations, documents, memories, and agent outputs live exclusively on your device in a local SQLite database. We designed Artha from the ground up so that privacy is the default, not an opt-in feature.

This policy explains what that means in practice, what limited data may be involved when you use optional cloud features, and what your rights are.

---

## 2. Definitions

- **Local Data**: All data you create, store, or process using Artha that remains on your device, including conversations, documents, file embeddings, agent memories, skill configurations, and usage preferences.
- **Cloud Features**: Optional features that require network connectivity, including OAuth-based authentication, cloud model API access (Bring Your Own Key / BYOK), and Pro/Team sync functionality.
- **Personal Data**: Any information that identifies or could identify a natural person, as defined under applicable law including the GDPR and CCPA.
- **Device**: The computer or workstation on which you install and run the Artha desktop application.

---

## 3. Data That Stays on Your Device (Default Behavior)

When you use Artha without enabling any optional Cloud Features, the following data is stored **only** on your local device and is **never transmitted to Artha or any third party**:

- **Conversations and Chat History**: Every message, prompt, response, and thread between you and Artha's AI agents.
- **Documents and File Embeddings**: Any files you import, index, or process within Artha, including their text content and vector embeddings.
- **Agent Memories**: Notes, facts, and context that Artha agents accumulate over time to personalize their responses to you.
- **Skill Configurations**: Custom agent skills, workflows, and automation rules you create or install.
- **Application Settings and Preferences**: Your UI configuration, model settings, theme preferences, and feature toggles.
- **Model Weights**: If you use Artha with Ollama or another locally-hosted model, the model weights run entirely on your hardware.

**Local inference means local inference.** When you run queries against a local model (e.g., via Ollama), your prompts and data are processed entirely on your device. No query is sent to Artha's servers or any external model provider.

All Local Data is stored in a SQLite database located at:
- **macOS**: `~/Library/Application Support/Artha/artha.db`
- **Windows**: `%APPDATA%\Artha\artha.db`
- **Linux**: `~/.config/Artha/artha.db`

You have full, unrestricted access to this database file at all times.

---

## 4. Optional Cloud Features and Associated Data

Certain optional features require network access. These features are explicitly opt-in and clearly labeled within the application. We describe each below.

### 4.1 Account Creation and OAuth Authentication

If you create an Artha account to access Pro or Team features, we collect:

- **Email address**: Used for account identification and communications about your subscription.
- **Authentication tokens**: Short-lived tokens managed via OAuth 2.0. We do not store your passwords.
- **Subscription and billing information**: Processed by our payment provider (currently [PLACEHOLDER: e.g., Stripe]). We receive confirmation of your subscription status but do not store full payment card details.
- **Account metadata**: Account creation date, subscription tier, and last login timestamp.

### 4.2 Cloud Sync (Pro and Team Tiers)

If you enable the optional cloud sync feature, encrypted snapshots of your Local Data may be transmitted to Artha's cloud infrastructure for the purpose of syncing between your devices. In this case:

- Data is **encrypted client-side** before transmission using AES-256 encryption. Artha's servers store only encrypted blobs; we cannot read your data.
- Sync is **explicitly opt-in** and can be disabled at any time from Settings > Privacy.
- You can delete all cloud-stored data at any time from your account settings.

### 4.3 Bring Your Own Key (BYOK) Cloud Model Access

If you configure Artha to route queries to a third-party cloud AI model (e.g., OpenAI, Anthropic, Google) using your own API key:

- Your prompts and relevant context are transmitted **directly from your device to your chosen cloud provider** using your API key.
- **Artha does not proxy, log, or store these requests.** The connection goes from your device to the provider.
- The third-party provider's privacy policy and terms govern their use of that data. You are responsible for reviewing those policies.
- Your API key is stored encrypted in your local device's secure keychain.

### 4.4 Telemetry and Crash Reporting

Artha **does not enable telemetry or crash reporting by default.** If you choose to opt into anonymous crash reporting (Settings > Privacy > Share Crash Reports), we may collect:

- Application version and operating system version
- Stack trace of the crash (no user data, conversation content, or file content is included)
- A randomly generated anonymous device identifier (not linked to your email or account)

You can opt out at any time. Crash reports are retained for 90 days and then permanently deleted.

### 4.5 Software Updates

Artha checks for software updates by making a network request to `updates.artha.app`. This request includes:
- Your current application version
- Your operating system type and version

No personal data or account information is included in update checks.

---

## 5. Data We Do Not Collect

To be unambiguous, we explicitly do not collect:

- The content of your conversations, prompts, or AI responses
- The content of any documents or files you import into Artha
- Your agent memories or skill configurations
- Behavioral analytics, keylogging, or screen recording data
- Location data
- Browser history or data from other applications on your device
- Any data from your device's file system beyond what you explicitly import into Artha

---

## 6. How We Use Information We Do Collect

For account holders who use Cloud Features, we use the data we collect to:

- **Provide the Service**: Manage your account, process subscription payments, and deliver Pro/Team functionality.
- **Communicate with you**: Send transactional emails (receipts, password resets, service notices). We will not send marketing emails without your explicit consent.
- **Improve the Service**: Aggregated, anonymized data about feature usage patterns (e.g., "what percentage of Pro users enable sync") may be used to guide product decisions, where we can do so without identifying individuals.
- **Security and fraud prevention**: Detect and prevent unauthorized access to accounts.
- **Legal compliance**: Meet obligations under applicable law.

We do not sell your data. We do not use your data to train AI models. We do not share your data with advertisers.

---

## 7. Data Sharing and Third Parties

We share limited data with the following categories of third parties, solely as necessary to operate the Service:

| Recipient | Purpose | Data Shared |
|---|---|---|
| Payment processor ([PLACEHOLDER: e.g., Stripe]) | Subscription billing | Email, billing address, payment method (handled directly by processor) |
| Cloud infrastructure provider ([PLACEHOLDER: e.g., AWS, Fly.io]) | Hosting account services and encrypted sync storage | Encrypted sync blobs (we cannot decrypt), account metadata |
| Authentication provider ([PLACEHOLDER: e.g., Auth0, Supabase]) | OAuth account management | Email, auth tokens |
| Crash reporting ([PLACEHOLDER: e.g., Sentry]) | Opt-in crash reports | Anonymized crash traces, app version, OS version |

We require all third-party processors to maintain confidentiality and security practices consistent with this policy and applicable law. We do not sell your data to third parties.

---

## 8. Data Retention

| Data Type | Retention Period |
|---|---|
| Local Data (on-device) | Retained until you delete Artha or delete it yourself. We have no access to this data. |
| Account information | Retained for the duration of your account plus 90 days after deletion, then permanently purged. |
| Encrypted sync data (if used) | Deleted within 30 days of account deletion or upon your explicit request. |
| Billing records | Retained for 7 years as required by financial regulations. |
| Opt-in crash reports | 90 days from submission. |
| Software update logs | 30 days, aggregated only. |

---

## 9. Security

We take reasonable technical and organizational measures to protect the account-level data we hold:

- All data transmitted to Artha's servers uses TLS 1.2 or higher.
- Cloud sync data is encrypted client-side with AES-256 before transmission.
- Access to production systems is restricted to authorized personnel and requires multi-factor authentication.
- We conduct periodic security reviews of our infrastructure.
- In the event of a data breach affecting your account data, we will notify you as required by applicable law, and in any event within 72 hours of becoming aware of the breach where required by the GDPR.

**The strongest security guarantee Artha offers, however, is architectural: if you use Artha with local inference and no cloud features, there is no data to breach on our end.**

---

## 10. Your Rights

### 10.1 Rights for All Users

Regardless of where you are located, you have the right to:

- **Access your Local Data**: It is on your device, in an open SQLite format, accessible at any time.
- **Delete your Local Data**: Delete the database file or use Artha's built-in data management tools.
- **Export your Local Data**: Artha provides a data export function (Settings > Data > Export) that produces a portable JSON or SQLite file of all your local data.

### 10.2 Rights for Account Holders (Cloud Features)

If you have an Artha account, you may contact us at [PLACEHOLDER: privacy@artha.app] to:

- **Access** the account-level data we hold about you
- **Correct** inaccurate account information
- **Delete** your account and associated data
- **Restrict** or **object to** certain processing
- **Port** your account data in a machine-readable format

We will respond to verifiable requests within 30 days (or within the timeframe required by applicable law).

---

## 11. GDPR — Additional Disclosures for European Users

If you are located in the European Economic Area (EEA), United Kingdom, or Switzerland, the following additional provisions apply.

**Data Controller**: [PLACEHOLDER: Legal entity name, address]

**Legal Bases for Processing**:

| Processing Activity | Legal Basis |
|---|---|
| Account creation and management | Contract (Article 6(1)(b) GDPR) |
| Subscription billing | Contract (Article 6(1)(b) GDPR) |
| Opt-in crash reporting | Consent (Article 6(1)(a) GDPR) |
| Security and fraud prevention | Legitimate interests (Article 6(1)(f) GDPR) |
| Legal compliance | Legal obligation (Article 6(1)(c) GDPR) |

**Data Transfers**: If you are in the EEA and we transfer your account data to countries outside the EEA, we rely on [PLACEHOLDER: Standard Contractual Clauses / adequacy decisions] to ensure an adequate level of protection.

**Right to Lodge a Complaint**: You have the right to lodge a complaint with your local supervisory authority. In the EU, this is your national Data Protection Authority. In the UK, this is the Information Commissioner's Office (ICO).

**Retention**: We apply data minimization principles and do not retain account data longer than necessary for the purposes described in Section 8.

---

## 12. CCPA — Additional Disclosures for California Residents

If you are a California resident, the California Consumer Privacy Act (CCPA) as amended by the CPRA grants you additional rights.

**Categories of Personal Information Collected** (for account holders only):

| Category | Collected? | Purpose |
|---|---|---|
| Identifiers (email, account ID) | Yes | Account management |
| Commercial information (subscription tier) | Yes | Service delivery |
| Internet or network activity | No (beyond update checks) | N/A |
| Geolocation data | No | N/A |
| Biometric data | No | N/A |
| Inferences drawn from personal information | No | N/A |

**Sale or Sharing of Personal Information**: We do not sell or share your personal information for cross-context behavioral advertising.

**Your CCPA Rights**:
- Right to Know: Request disclosure of the categories and specific pieces of personal information we have collected.
- Right to Delete: Request deletion of personal information we hold.
- Right to Correct: Request correction of inaccurate personal information.
- Right to Opt-Out of Sale/Sharing: We do not sell or share your data, so no opt-out mechanism is required, but you may contact us to confirm.
- Right to Non-Discrimination: We will not discriminate against you for exercising your CCPA rights.

To exercise these rights, contact us at [PLACEHOLDER: privacy@artha.app] or [PLACEHOLDER: toll-free number if required].

---

## 13. Children's Privacy

Artha is not directed to children under the age of 13 (or 16 in certain jurisdictions). We do not knowingly collect personal information from children. If we learn that we have inadvertently collected such data, we will delete it promptly. If you believe a child has provided us with personal information, please contact us at [PLACEHOLDER: privacy@artha.app].

---

## 14. Changes to This Policy

We may update this Privacy Policy from time to time. When we make material changes, we will:
- Update the "Last Updated" date at the top of this document
- Display a notice within the Artha application
- For significant changes affecting account holders, send an email notification to the address on file

Your continued use of the Service after the effective date of a revised policy constitutes your acceptance of the changes. If you disagree with a change, you may close your account and stop using cloud features; your local data remains entirely under your control regardless.

---

## 15. Contact Information

For privacy-related questions, requests, or concerns:

**Privacy Team**
[PLACEHOLDER: Legal Entity Name]
[PLACEHOLDER: Street Address]
[PLACEHOLDER: City, State/Province, Postal Code, Country]

Email: [PLACEHOLDER: privacy@artha.app]
Response time: We aim to respond within 5 business days.

For GDPR-specific requests: [PLACEHOLDER: dpo@artha.app] (if a DPO is appointed)

---

*This Privacy Policy was written to be readable, not just legally defensible. If something is unclear, please reach out — we want you to understand exactly how your data is handled.*
