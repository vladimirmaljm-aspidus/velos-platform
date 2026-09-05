import type { ReactNode } from "react";
import {
  LegalSection,
  LegalSub,
  LegalP,
  LegalLi,
  LegalList,
  LegalTable,
  type LegalTocEntry,
} from "@/components/legal/legal-document";
import { LEGAL_OPERATOR, PRIVACY_POLICY } from "@/components/legal/legal-meta";

/* ═══════════════════════════════════════════════════════════════════════════
   VELOS Privacy Policy — document body (authoritative English text)

   Grounded in what the platform ACTUALLY processes (verified against code):
   - Registration: company name, contact name, e-mail, phone, country
   - Workspace business records: partners, products, offers, deals, invoices,
     proformas, LOIs, logistics, documents, templates (Customer Data)
   - KYC: documents uploaded via portal by counterparty companies
   - Security data: IP address (rate limiting, last-login record), user agent,
     audit trail entries (action, entity, timestamp), failed sign-in counters,
     lockouts, TOTP 2FA settings, hashed recovery codes
   - Session cookie "crm_session" (HttpOnly); locale preference (cookie +
     localStorage); no advertising or tracking cookies
   - Transactional e-mail (notifications, trial warnings, welcome mails)
   - Processors: Supabase (database, ap-southeast-2 / Sydney), Vercel (global
     edge hosting), e-mail delivery provider
   - Passwords stored ONLY as salted hashes; TOTP secrets encrypted at rest

   When changing what the platform collects, update this document AND bump
   PRIVACY_POLICY version + effective date in legal-meta.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

const O = LEGAL_OPERATOR;

export const PRIVACY_SECTIONS: LegalTocEntry[] = [
  { n: 1, id: "sec-1", title: "Who We Are and How to Reach Us" },
  { n: 2, id: "sec-2", title: "Scope of this Policy" },
  { n: 3, id: "sec-3", title: "Data We Collect" },
  { n: 4, id: "sec-4", title: "How and Why We Use Data (Legal Bases)" },
  { n: 5, id: "sec-5", title: "Cookies and Local Storage" },
  { n: 6, id: "sec-6", title: "Sharing and Recipients" },
  { n: 7, id: "sec-7", title: "International Data Transfers" },
  { n: 8, id: "sec-8", title: "How Long We Keep Data" },
  { n: 9, id: "sec-9", title: "Security Measures" },
  { n: 10, id: "sec-10", title: "Your Rights" },
  { n: 11, id: "sec-11", title: "Exercising Your Rights" },
  { n: 12, id: "sec-12", title: "Automated Decision-Making and Profiling" },
  { n: 13, id: "sec-13", title: "Children" },
  { n: 14, id: "sec-14", title: "Changes to this Policy" },
  { n: 15, id: "sec-15", title: "Complaints and Supervisory Authorities" },
];

export function PrivacyPolicy(): ReactNode {
  return (
    <>
      {/* ── 1 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={1} title="Who We Are and How to Reach Us">
        <LegalP>
          {O.legalEntity} (&ldquo;<strong>VELOS</strong>&rdquo;, &ldquo;<strong>we</strong>&rdquo;,
          &ldquo;<strong>us</strong>&rdquo;), registered office at {O.registeredOffice}, is the
          data controller for the personal data described in this policy, in respect of the VELOS
          trade-management platform and the associated client portal (together, the
          &ldquo;<strong>Service</strong>&rdquo;).
        </LegalP>
        <LegalTable
          head={["Purpose", "Contact point"]}
          rows={[
            ["Data-protection matters, rights requests, this policy", O.privacyEmail],
            ["Legal notices, terms of service, contracts", O.contactEmail],
          ]}
        />
        <LegalP>
          We have not appointed a dedicated Data Protection Officer because we are not required
          to under applicable law; the {O.privacyEmail} mailbox is monitored by the team member
          responsible for data protection, and correspondence is handled under privilege where
          you request it.
        </LegalP>
      </LegalSection>

      {/* ── 2 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={2} title="Scope of this Policy">
        <LegalList
          >
            <LegalLi>This policy applies to personal data we process through the Service, including data processed when you register for a trial, use your workspace, use the client portal as a counterparty contact, or receive e-mail from the Service.</LegalLi>
            <LegalLi>This policy does not govern Customer Data that you (as a tenant business) process about your own contacts through your workspace. For that processing, YOU are the controller and we act as processor — see Section 4.3 and the Terms of Service, Section 22. Your counterparties should be directed to YOUR privacy policy.</LegalLi>
            <LegalLi>It also does not apply to third-party websites or services reachable from or integrated with the Service.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 3 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={3} title="Data We Collect">
        <LegalSub n="3.1" title="Account and registration data">
          <LegalP>
            When you submit a workspace registration we collect: company name; your full name and
            role; work e-mail address; telephone number (optional); country; and the password you
            choose (stored only as a salted hash — never in readable form). Your IP address and
            browser user-agent are recorded at submission for rate-limiting and abuse prevention.
          </LegalP>
        </LegalSub>
        <LegalSub n="3.2" title="Workspace business records (Customer Data)">
          <LegalP>
            The records you and your users create — partners and contacts, products, offers,
            demands, deals, invoices, proformas, letters of intent, logistics records, document
            templates, uploaded documents and KYC files. These may contain personal data of your
            contacts (names, business e-mails, telephone numbers, signatures on documents). We
            process this on your instruction, as your processor.
          </LegalP>
        </LegalSub>
        <LegalSub n="3.3" title="Security and technical data">
          <LegalList
            >
              <LegalLi>IP addresses — used for registration and sign-in rate limiting, lockout enforcement, and recorded with your most recent sign-in and with security-relevant events.</LegalLi>
              <LegalLi>Audit-trail entries — for actions performed in the Service we record: the acting username, timestamp, the action (e.g. record created, document sent), the affected entity, and the IP address at the time of the action. The audit trail exists for security investigation and integrity verification.</LegalLi>
              <LegalLi>Authentication telemetry — failed sign-in attempt counters, account lockout timestamps, two-factor-authentication enrolment state, hashed recovery codes, password-change events.</LegalLi>
              <LegalLi>Session data — a signed session token in the cookie described in Section 5; we do not record your browsing within the Service beyond the audit-trail entries above.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="3.4" title="Communications data">
          <LegalP>
            Transactional e-mail (workspace approval, trial status and expiry warnings,
            subscription notices, security alerts, password reset, portal invitations) is sent to
            your administrator and user addresses. We keep delivery records to diagnose
            non-delivery. We do not send marketing e-mail without a separate opt-in.
          </LegalP>
        </LegalSub>
        <LegalSub n="3.5" title="What we deliberately do NOT collect">
          <LegalList
            >
              <LegalLi>No advertising identifiers, cross-site trackers, or third-party analytics cookies.</LegalLi>
              <LegalLi>No payment-card data — the trial requires no card, and where paid plans use external billing, we store no card numbers.</LegalLi>
              <LegalLi>No biometric data, and no special-category personal data is knowingly collected; see Section 3.6 if such data is submitted in error.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="3.6" title="KYC documents and special categories">
          <LegalP>
            Know-your-customer documents uploaded through the portal may incidentally contain
            identity-document numbers or other personal data. Responsibility for the lawfulness of
            those uploads lies with the uploading business (Terms of Service, Section 12). If you
            believe special-category data was uploaded in error, contact {O.privacyEmail} and we
            will assist with its removal.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 4 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={4} title="How and Why We Use Data (Legal Bases)">
        <LegalSub n="4.1" title="Purposes and legal bases (our controller processing)">
          <LegalTable
            head={["Purpose", "Data involved", "Legal basis"]}
            rows={[
              [
                "Providing, securing and administering the Service and your workspace",
                "Account data; security and technical data; audit trail",
                "Performance of the contract with you (GDPR Art. 6(1)(b)); equivalent provisions of UAE PDPL and other applicable laws",
              ],
              [
                "Reviewing registration requests and approving workspaces (one review per request)",
                "Registration data; IP address",
                "Legitimate interest in operating a secure B2B service (GDPR Art. 6(1)(f)) — preventing abuse, duplicate registrations and automated sign-up attacks",
              ],
              [
                "Rate limiting, account lockout, fraud and abuse prevention, security incident response",
                "IP addresses; authentication telemetry; audit trail",
                "Legitimate interest (GDPR Art. 6(1)(f)); compliance with security obligations",
              ],
              [
                "Sanctions and restricted-party screening of registration and, where legally required, counterparty data",
                "Company and contact names; country; e-mail",
                "Compliance with legal obligations (GDPR Art. 6(1)(c)); prevention of unlawful acts",
              ],
              [
                "Transactional notifications (trial status, security, password reset)",
                "E-mail address; account status",
                "Performance of the contract; compliance with legal obligations; legitimate interest in keeping accounts secure",
              ],
              [
                "Answering support, legal and data-protection enquiries",
                "Correspondence content; account identifiers",
                "Legitimate interest; performance of the contract",
              ],
              [
                "Defending legal claims; keeping statutory business records",
                "Account and audit-trail records; correspondence",
                "Legitimate interest (GDPR Art. 6(1)(f)); legal obligation where applicable",
              ],
            ]}
          />
        </LegalSub>
        <LegalSub n="4.2" title="No marketing by default">
          <LegalP>
            If we later offer optional product updates by e-mail, they are sent only where you
            opt in, and every such message carries a working unsubscribe. Your consent can be
            withdrawn at any time without affecting the lawfulness of prior processing.
          </LegalP>
        </LegalSub>
        <LegalSub n="4.3" title="Processing on your instruction (we act as processor)">
          <LegalP>
            For Customer Data you control, we act as your processor under the Terms of Service
            (Section 22) and this policy. We process Customer Data only to provide the Service, on
            your documented instruction, and we will not access it except: (a) to operate and
            secure the Service; (b) when you request support; (c) when required by law, subject to
            Section 6.3. On request we enter into a data-processing agreement covering GDPR Art. 28
            or equivalent requirements — contact {O.privacyEmail}.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 5 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={5} title="Cookies and Local Storage">
        <LegalTable
          head={["Item", "Type", "Lifetime", "Purpose"]}
          rows={[
            [
              "crm_session",
              "Strictly necessary cookie",
              "Session duration (signed token; cleared on sign-out)",
              "Keeps you signed in; HttpOnly so scripts cannot read it",
            ],
            [
              "Locale preference",
              "Strictly necessary cookie + localStorage",
              "Persistent (until you change language or clear browser data)",
              "Remembers your interface language",
            ],
            [
              "Pending form state (registration and portal forms)",
              "Local storage (browser only)",
              "Short-lived",
              "Restores a half-completed form after a reload",
            ],
          ]}
        />
        <LegalP>
          The Service sets <strong>no</strong> advertising, analytics or tracking cookies. Because
          only strictly necessary storage is used, the Service functions without a consent banner;
          blocking these items in your browser will simply require you to sign in again and
          reselect your language.
        </LegalP>
      </LegalSection>

      {/* ── 6 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={6} title="Sharing and Recipients">
        <LegalSub n="6.1" title="Processors (sub-contractors)">
          <LegalTable
            head={["Processor", "Function", "Location notes"]}
            rows={[
              [
                "Supabase (database and storage for the Service)",
                "Hosts the Service database and uploaded documents",
                "Primary database region: Australia (Sydney); subject to Section 7 safeguards",
              ],
              [
                "Vercel (application hosting and global content delivery)",
                "Serves the application through regional edge infrastructure",
                "Global network; subject to Section 7 safeguards",
              ],
              [
                "E-mail delivery provider",
                "Delivers transactional e-mail",
                "Subject to data-processing terms",
              ],
            ]}
          />
          <LegalP>
            Processors are bound by written data-processing terms, may use the data only on our
            instruction, and are reviewed for security and privacy practices. We do not transfer
            Customer Data to processors outside this list without notice to the tenant
            administrator.
          </LegalP>
        </LegalSub>
        <LegalSub n="6.2" title="Other recipients">
          <LegalList
            >
              <LegalLi>Members of your own workspace (your colleagues and users you invite) — for the Customer Data in your workspace, this is disclosure within your instruction, not a transfer by us.</LegalLi>
              <LegalLi>Portal counterparties — your customers see the documents you explicitly share through the portal.</LegalLi>
              <LegalLi>Professional advisers (auditors, legal counsel) under confidentiality, where required for the operation or defence of the business.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="6.3" title="Legal compulsion">
          <LegalP>
            We may disclose personal data to competent authorities where required by law —
            including sanctions, export-control, criminal and data-protection authorities — or to
            protect vital interests. Where the law permits, we notify the affected tenant
            administrator before disclosure; where the law prohibits notice (for example
            anti-tipping-off rules), we disclose as required and document the request.
          </LegalP>
        </LegalSub>
        <LegalSub n="6.4" title="No sale of data">
          <LegalP>
            We do not sell, rent, or trade personal data, and we do not disclose it to third
            parties for their own marketing.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 7 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={7} title="International Data Transfers">
        <LegalList
          >
            <LegalLi>Our primary database is hosted in Australia (Sydney region) and our application hosting uses a global edge network, so personal data may be processed in the United Arab Emirates, Australia, the United States, the European Union and other regions where our processors operate.</LegalLi>
            <LegalLi>Where personal data of individuals in the European Economic Area or the United Kingdom is transferred to a country without an adequacy decision, we rely on the European Commission's Standard Contractual Clauses (or the UK International Data Transfer Addendum) with the recipient, together with the technical measures in Section 9.</LegalLi>
            <LegalLi>Equivalent transfer mechanisms are used where other laws (including UAE PDPL and its implementing regulations) require them.</LegalLi>
            <LegalLi>You may request a copy of the safeguards applied to a specific transfer by writing to " + O.privacyEmail + ".</LegalLi></LegalList>
      </LegalSection>

      {/* ── 8 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={8} title="How Long We Keep Data">
        <LegalTable
          head={["Data", "Retention"]}
          rows={[
            [
              "Account and registration data (active workspace)",
              "For the life of the workspace, while the account is active",
            ],
            [
              "Customer Data in a suspended or terminated workspace",
              "Retained read-protected for at least 90 days (the Terms of Service Retrieval Window) to permit export; deleted thereafter in the ordinary course, unless a longer statutory period applies",
            ],
            [
              "Audit-trail entries",
              "Retained for up to 24 months for security investigation and integrity verification, then aggregated or deleted, except entries tied to legal holds or statutory record-keeping",
            ],
            [
              "Security events and sign-in records",
              "Up to 12 months for security operations",
            ],
            [
              "Registration records that were never approved",
              "Deleted within 90 days of submission or rejection",
            ],
            [
              "Transactional e-mail delivery records",
              "Up to 12 months, for delivery diagnostics and abuse investigation",
            ],
            [
              "Consent and acceptance records (Terms/Privacy version you accepted)",
              "Retained for the duration of the account plus the statutory limitation period for contract claims — this is the evidence of the agreement version in force",
            ],
          ]}
        />
        <LegalP>
          Where retention periods in this table conflict with a statutory obligation (for example
          anti-money-laundering or accounting record-keeping), the statutory period prevails for
          the minimum data necessary to comply. Otherwise, data is deleted or anonymised when the
          purpose ends.
        </LegalP>
      </LegalSection>

      {/* ── 9 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={9} title="Security Measures">
        <LegalP>
          The Service is built with security as a design constraint. Measures in place include,
          at the time of this version:
        </LegalP>
        <LegalList
          >
            <LegalLi>Passwords stored exclusively as salted hashes; a platform password policy is enforced at registration and change.</LegalLi>
            <LegalLi>Optional time-based one-time-password (TOTP) two-factor authentication, with recovery codes stored only as hashes.</LegalLi>
            <LegalLi>Signed, HttpOnly session cookies; sessions are invalidated by credential changes and can be revoked account-wide.</LegalLi>
            <LegalLi>Per-tenant data isolation in the data model; authorisation checked server-side on every request.</LegalLi>
            <LegalLi>Database-backed rate limiting on authentication and registration endpoints, per IP address and per account.</LegalLi>
            <LegalLi>An append-only audit trail over business records and security-relevant actions, used for investigation and integrity checks.</LegalLi>
            <LegalLi>Encryption of data in transit (TLS) between users and the Service and towards our processors.</LegalLi>
            <LegalLi>Layered key management for signing and field-encryption operations, with defined rotation procedures, and encrypted storage for sensitive fields (for example two-factor secrets).</LegalLi>
            <LegalLi>Security event monitoring with alert routing to the operations team.</LegalLi>
            <LegalLi>A documented incident-response process, including breach assessment and notification obligations (Section 15).</LegalLi></LegalList>
        <LegalP>
          No system is perfectly secure. If a personal-data breach affecting your data occurs, we
          will assess it and, where the law requires, notify the competent supervisory authority
          and the affected individuals without undue delay, and inform the affected tenant
          administrator of what happened and what we did.
        </LegalP>
      </LegalSection>

      {/* ── 10 ────────────────────────────────────────────────────────── */}
      <LegalSection n={10} title="Your Rights">
        <LegalP>
          Depending on where you live and the law that protects you, you may have some or all of
          the following rights. They apply to our controller processing (Section 4.1); for Customer
          Data held in a tenant workspace, direct your request to that business, which is the
          controller (Section 2).
        </LegalP>
        <LegalTable
          head={["Right", "What it means"]}
          rows={[
            ["Access (GDPR Art. 15)", "A copy of the personal data we hold about you, with the details the law requires."],
            ["Rectification (Art. 16)", "Correction of inaccurate personal data about you."],
            ["Erasure (Art. 17)", "Deletion of your personal data, subject to the retention obligations in Section 8 — for example, records we must keep to evidence the contract or comply with law."],
            ["Restriction (Art. 18)", "Pausing certain processing while a dispute about accuracy or lawful basis is resolved."],
            ["Portability (Art. 20)", "Receiving, in a structured, machine-readable format, data you provided to us that we process on consent or contract, and having it sent to another provider where technically feasible."],
            ["Objection (Art. 21)", "Objecting to processing based on legitimate interests, including profiling-based legitimate-interest processing; we will stop unless compelling legitimate grounds override."],
            ["Withdraw consent", "Where processing rests on consent (e.g. optional product updates), withdrawing it at any time; withdrawal does not affect earlier processing."],
            ["Not automated-only decisions (Art. 22)", "Not to be subject to decisions with legal effect based solely on automated processing — see Section 12; our protective automation always has human review on escalation."],
            ["Complain", "Lodge a complaint with a supervisory authority (Section 15)."],
          ]}
        />
        <LegalP>
          Under the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021) and
          equivalent national laws, comparable rights are provided to individuals in those
          jurisdictions, and we honour them through the same request process.
        </LegalP>
      </LegalSection>

      {/* ── 11 ────────────────────────────────────────────────────────── */}
      <LegalSection n={11} title="Exercising Your Rights">
        <LegalList
          ordered
          >
            <LegalLi>
              Write to <strong>{O.privacyEmail}</strong> from the e-mail address associated with
              your account (this lets us verify you without excessive extra data). Describe the
              right you are exercising and, if relevant, the workspace or portal involved.
            </LegalLi>
            <LegalLi>
              We verify your identity before disclosing or changing data — using information
              already held on your account, and only asking for more where necessary (for example
              a signed request on business letterhead where the request comes from a corporate
              domain we cannot match).
            </LegalLi>
            <LegalLi>
              You will receive a substantive response within one month. Where a request is complex
              or numerous, we may extend by two further months and will tell you within the first
              month. If we cannot comply (for example because a statutory retention duty
              conflicts), we will explain which part we cannot fulfil and why.
            </LegalLi>
            <LegalLi>
              Requests are free of charge. A reasonable fee may apply where requests are manifestly
              unfounded, excessive or repetitive — we will explain the basis before charging.
            </LegalLi>
          </LegalList>
      </LegalSection>

      {/* ── 12 ────────────────────────────────────────────────────────── */}
      <LegalSection n={12} title="Automated Decision-Making and Profiling">
        <LegalList
          >
            <LegalLi>We do not carry out profiling for marketing, and we do not make decisions with legal effect about you based solely on automated processing.</LegalLi>
            <LegalLi>Protective automation that can affect your access includes: account lockout after repeated failed sign-ins; registration and sign-in rate limiting by IP address; automatic suspension of a workspace at trial or subscription expiry; and automatic flagging of registrations or counterparty records for sanctions review. Each of these has defined human escalation: your administrator can contact us, and flagged items are reviewed by a person before account-level action beyond the temporary protective measure.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 13 ────────────────────────────────────────────────────────── */}
      <LegalSection n={13} title="Children">
        <LegalP>
          The Service is a business tool and is not directed at individuals under eighteen (18).
          We do not knowingly collect data from children. If you believe a child has provided
          personal data through the Service, contact {O.privacyEmail} and we will delete it
          promptly.
        </LegalP>
      </LegalSection>

      {/* ── 14 ────────────────────────────────────────────────────────── */}
      <LegalSection n={14} title="Changes to this Policy">
        <LegalList
          >
            <LegalLi>This policy has version " + PRIVACY_POLICY.version + ", effective " + PRIVACY_POLICY.effectiveDateLabel + ". The version in force is always the one published at /legal/privacy.</LegalLi>
            <LegalLi>Material changes (new categories of data, new purposes, new processors or transfers) are announced to workspace administrators at least thirty (30) days before taking effect, and where the change concerns processing based on consent, we will seek fresh consent where the law requires it.</LegalLi>
            <LegalLi>The version history and your recorded acceptances are retained in the audit trail, so the policy in force for your account can always be established.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 15 ────────────────────────────────────────────────────────── */}
      <LegalSection n={15} title="Complaints and Supervisory Authorities">
        <LegalP>
          You may complain to us first at {O.privacyEmail} — most issues are resolved fastest that
          way. You also have the right to lodge a complaint with a data-protection supervisory
          authority, in particular (but not only) the authority of your habitual residence or
          place of work if you consider our processing violates applicable law. For example:
        </LegalP>
        <LegalTable
          head={["Jurisdiction", "Authority"]}
          rows={[
            ["European Union member states", "The competent Data Protection Authority of your member state"],
            ["United Kingdom", "Information Commissioner's Office (ico.org.uk)"],
            ["United Arab Emirates", "The UAE Data Office, in accordance with Federal Decree-Law No. 45 of 2021"],
            ["Serbia", "Poverenik za informacije od javnog značaja i zaštitu podataka o ličnosti"],
            ["Türkiye", "Kişisel Verileri Koruma Kurumu (KVKK)"],
          ]}
        />
        <LegalP>
          Contact points remain {O.privacyEmail} (privacy) and {O.contactEmail} (legal and
          contractual). This policy is part of the VELOS legal framework together with the Terms
          of Service.
        </LegalP>
      </LegalSection>
    </>
  );
}
