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
import { LEGAL_OPERATOR, TERMS_OF_SERVICE, TRIAL_TERMS } from "@/components/legal/legal-meta";

/* ═══════════════════════════════════════════════════════════════════════════
   VELOS Terms of Service — document body (authoritative English text)

   Grounded in the platform's actual behaviour:
   - 14-day trial starting on ADMIN APPROVAL, not on sign-up submission
   - one workspace per company, data isolated per tenant
   - trial accounts carry a restricted permission set and module flags
   - plan quotas (users / partners / products / monthly documents)
   - automatic suspension on trial or subscription expiry, 48h warning
   - audit trail on every write; credential hashing; optional 2FA
   - no payment instrument is collected during the trial

   Any behavioural claim made here MUST match the shipped code — update
   this document together with the feature, and bump TERMS_OF_SERVICE
   version + effective date in legal-meta.ts when it changes materially.
   ═══════════════════════════════════════════════════════════════════════════ */

const O = LEGAL_OPERATOR;

export const TOS_SECTIONS: LegalTocEntry[] = [
  { n: 1, id: "sec-1", title: "Definitions and Interpretation" },
  { n: 2, id: "sec-2", title: "Formation of the Agreement and Acceptance" },
  { n: 3, id: "sec-3", title: "Eligibility and Authority" },
  { n: 4, id: "sec-4", title: "The Service and Service Modifications" },
  { n: 5, id: "sec-5", title: "Accounts, Credentials and Security" },
  { n: 6, id: "sec-6", title: "Trial Period" },
  { n: 7, id: "sec-7", title: "Subscriptions, Plans and Fees" },
  { n: 8, id: "sec-8", title: "Quotas and Fair Use" },
  { n: 9, id: "sec-9", title: "Acceptable Use Policy" },
  { n: 10, id: "sec-10", title: "Trade, Sanctions and Export-Control Compliance" },
  { n: 11, id: "sec-11", title: "Anti-Bribery and Anti-Money-Laundering" },
  { n: 12, id: "sec-12", title: "Customer Data and Customer Responsibilities" },
  { n: 13, id: "sec-13", title: "Intellectual Property" },
  { n: 14, id: "sec-14", title: "Confidentiality" },
  { n: 15, id: "sec-15", title: "Third-Party Services and Integrations" },
  { n: 16, id: "sec-16", title: "Service Availability and Support" },
  { n: 17, id: "sec-17", title: "Disclaimers" },
  { n: 18, id: "sec-18", title: "Limitation of Liability" },
  { n: 19, id: "sec-19", title: "Indemnification" },
  { n: 20, id: "sec-20", title: "Term, Suspension and Termination" },
  { n: 21, id: "sec-21", title: "Effect of Termination; Data Retrieval" },
  { n: 22, id: "sec-22", title: "Data Protection and Privacy" },
  { n: 23, id: "sec-23", title: "Notices and Communications" },
  { n: 24, id: "sec-24", title: "Amendments to These Terms" },
  { n: 25, id: "sec-25", title: "Governing Law and Dispute Resolution" },
  { n: 26, id: "sec-26", title: "Miscellaneous Provisions" },
];

export function TermsOfService(): ReactNode {
  return (
    <>
      {/* ── 1 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={1} title="Definitions and Interpretation">
        <LegalP>
          In this agreement (the <strong>&ldquo;Terms&rdquo;</strong>), the following terms have the
          meanings set out below. Defined terms appear capitalised throughout.
        </LegalP>
        <LegalList
          >
            <LegalLi term="VELOS, We, Us">
              {O.legalEntity}, a company licensed in the Dubai Multi Commodities Centre, Dubai,
              United Arab Emirates, operating the VELOS trade-management platform and any related
              services, together with its employees, officers, agents and permitted subcontractors.
            </LegalLi>
            <LegalLi term="Customer, You">
              the business entity that submits a registration for a VELOS workspace and, upon
              acceptance of these Terms, is granted access to the Service. References to
              &ldquo;you&rdquo; include your employees, officers and agents who use the Service on
              your behalf under an Authorised User account.
            </LegalLi>
            <LegalLi term="Service">
              the VELOS trade-management platform made available at velos-platform.vercel.app or any
              successor domain designated by us, including the web application, the customer
              portal, the application programming interfaces (&ldquo;APIs&rdquo;), integrations,
              documentation and updates, as modified from time to time.
            </LegalLi>
            <LegalLi term="Workspace, Tenant">
              the logically isolated data environment provisioned for a single Customer, in which
              that Customer&rsquo;s business records (partners, products, offers, deals, invoices,
              documents and related data) are stored and are not visible to other Customers.
            </LegalLi>
            <LegalLi term="Authorised User">
              an individual who is your employee, contractor or agent, whom you have permitted to
              access your Workspace under credentials issued by you or by us at your request.
            </LegalLi>
            <LegalLi term="Customer Data">
              all data, documents, records, files and materials submitted, uploaded or generated by
              or on behalf of you or your Authorised Users within the Service, including partner
              records, offer and deal data, invoices, proformas, letters of intent, logistics
              records, know-your-customer documents and portal content.
            </LegalLi>
            <LegalLi term="Trial Period">
              the complimentary evaluation window described in Section 6.
            </LegalLi>
            <LegalLi term="Plan">
              the subscription tier (Trial, Starter, Business, Enterprise or any successor tier)
              selected by you, together with the quotas and feature scope published for that tier
              in the Service&rsquo;s Plans section at the time of selection.
            </LegalLi>
            <LegalLi term="Subscription Fees">
              the fees payable for a paid Plan, as published in the Service or set out in an order
              form, quotation or invoice issued by us.
            </LegalLi>
            <LegalLi term="Effective Date">
              {TERMS_OF_SERVICE.effectiveDateLabel}, the date on which this version of the Terms
              takes effect.
            </LegalLi>
          </LegalList>
        <LegalP>
          Headings are for convenience only. The words &ldquo;including&rdquo; and
          &ldquo;include&rdquo; are without limitation. References to a statute include any
          amendment, re-enactment or replacement of it. The singular includes the plural and vice
          versa.
        </LegalP>
      </LegalSection>

      {/* ── 2 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={2} title="Formation of the Agreement and Acceptance">
        <LegalList
          ordered
          >
            <LegalLi>
              These Terms form a binding agreement between you and {O.legalEntity} governing your
              access to and use of the Service. By submitting the registration form, checking the
              consent box and creating a Workspace, you confirm that you have read, understood and
              agree to be bound by these Terms and by our Privacy Policy, which is incorporated by
              reference.
            </LegalLi>
            <LegalLi>
              You accept these Terms on behalf of the business entity you register. If you register
              on behalf of an employer or another entity, you represent and warrant that you are
              duly authorised to bind that entity to these Terms (see Section 3).
            </LegalLi>
            <LegalLi>
              <strong>Enforceable record of acceptance.</strong> When you accept these Terms, we
              record the acceptance in our audit trail: your account e-mail, the timestamp, the
              document reference and version ({TERMS_OF_SERVICE.ref} v{TERMS_OF_SERVICE.version}),
              and your network address. This record is kept as evidence of the agreed version of
              the Terms and prevails over any assertion to the contrary.
            </LegalLi>
            <LegalLi>
              If you do not agree to these Terms, you must not register for or use the Service. No
              other terms — including any purchase order, term sheet, e-mail confirmation or terms
              posted on your own website — modifies these Terms unless expressly agreed by us in a
              signed written amendment.
            </LegalLi>
          </LegalList>
      </LegalSection>

      {/* ── 3 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={3} title="Eligibility and Authority">
        <LegalList
          >
            <LegalLi>The Service is made available to business users only. You must be at least eighteen (18) years old and, if you register on behalf of a company, duly authorised to act for that company.</LegalLi>
            <LegalLi>You represent and warrant that the registration information you submit (company name, contact name, e-mail, telephone, country) is accurate, current and complete, and that the contact details belong to the registering entity or an authorised representative of it.</LegalLi>
            <LegalLi>One Workspace is provisioned per Customer (company). Registering duplicate Workspaces for the same business entity in order to obtain additional Trial Periods, quota or free usage is a material breach of these Terms and entitles us to suspend or terminate all such Workspaces immediately.</LegalLi>
            <LegalLi>We may, at our sole discretion and in accordance with applicable law, refuse or condition any registration, require additional know-your-customer documentation, or limit the availability of the Service to certain countries, industries or persons.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 4 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={4} title="The Service and Service Modifications">
        <LegalP>
          The Service provides a multi-tenant trade-management environment comprising, among other
          functions: partner and product management; offer, deal and demand tracking; landed-cost
          and margin calculation; invoice, proforma and letter-of-intent generation with document
          templating; a client portal with know-your-customer (KYC) document exchange; logistics
          tracking; reporting; and integration interfaces. The exact feature set available to you
          depends on your Plan.
        </LegalP>
        <LegalList
          >
            <LegalLi>We may add, modify, deprecate or remove features of the Service, provided that any removal or material degradation of a function that is core to trade-document generation and data export is accompanied by at least thirty (30) days' notice where reasonably practicable, and that we do not remove your ability to export Customer Data in a structured, machine-readable format.</LegalLi>
            <LegalLi>The Service is provided on a software-as-a-service basis. You acquire a right of use for the subscription term; no software is licensed to you for on-premises installation.</LegalLi>
            <LegalLi>We are under no obligation to supply new features developed for other Plans to your Plan, and feature availability published for a Plan may change as the Service evolves.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 5 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={5} title="Accounts, Credentials and Security">
        <LegalList
          >
            <LegalLi>You are responsible for the confidentiality of the credentials used to access the Service, including passwords, two-factor authentication devices, API keys and session tokens issued within your Workspace.</LegalLi>
            <LegalLi>You must notify us without undue delay at " + O.contactEmail + " upon becoming aware of any unauthorised use of an account or any other security incident affecting your Workspace. We may require verification of your identity before acting on such notice.</LegalLi>
            <LegalLi>We may, for security reasons, temporarily lock an account after repeated failed sign-in attempts, rate-limit authentication and registration endpoints by network address, and invalidate active sessions after a password or two-factor-authentication change. These protective controls are described further in the Privacy Policy and are not a suspension under Section 20.</LegalLi>
            <LegalLi>Where two-factor authentication is enabled, you are responsible for keeping the recovery codes issued at enrolment. Lost recovery codes or a lost authenticator device may require identity verification through our support process before access is restored.</LegalLi>
            <LegalLi>You must maintain at least one active administrator account for your Workspace and keep the contact e-mail for that account current; notices sent to the administrator e-mail address are deemed received under Section 23.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 6 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={6} title="Trial Period">
        <LegalSub n="6.1" title="Grant and commencement">
          <LegalP>
            We may make a Trial Period of {TRIAL_TERMS.days} days available to new Customers.
            Registration alone does not start the Trial: sign-up requests are held for review, and
            the Trial Period commences only when a platform administrator approves your request.
            You will be notified by e-mail upon approval.
          </LegalP>
        </LegalSub>
        <LegalSub n="6.2" title="Trial scope">
          <LegalList
            >
              <LegalLi>No payment instrument is requested or charged for the Trial Period.</LegalLi>
              <LegalLi>Trial Workspaces operate with a restricted feature scope (for example, a limited number of user seats and reduced document volume) compared with paid Plans. The exact trial scope is displayed in the Service.</LegalLi>
              <LegalLi>Your Customer Data is stored in the same isolated, per-Workspace environment used by paid Customers.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="6.3" title="Expiry and suspension">
          <LegalP>
            The Trial Period expires automatically at the end of the {TRIAL_TERMS.days}-day window;
            no charge occurs at expiry. We send a warning before expiry. Upon expiry the Workspace
            is suspended: sign-in is blocked and automated processing of your data stops, but the
            data is retained for a grace period to allow you to subscribe (Section 21).
          </LegalP>
        </LegalSub>
        <LegalSub n="6.4" title="One trial per entity">
          <LegalP>
            The Trial Period is granted once per business entity. We reserve the right to decline,
            curtail or end a Trial Period at any time where we reasonably suspect abuse, duplicate
            registration, misrepresentation, or a sanctions, export-control or acceptable-use
            concern (Sections 9 to 11), without liability to you.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 7 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={7} title="Subscriptions, Plans and Fees">
        <LegalSub n="7.1" title="Plans and quotas">
          <LegalP>
            Paid Plans (Starter, Business, Enterprise, and any tier we publish thereafter) carry
            the quotas and feature scope published in the Service&rsquo;s Plans section at the
            time you select them — including limits on users, partners, products and monthly
            document generation. Quotas are enforced automatically; when a quota is reached, the
            affected write operations are declined until the quota resets or the Plan is upgraded.
          </LegalP>
        </LegalSub>
        <LegalSub n="7.2" title="Ordering and billing">
          <LegalList
            >
              <LegalLi>Plan subscriptions are activated either self-service in the Service or upon our written acceptance of your order or plan-upgrade request. Where a subscription is subject to review, it takes effect when we confirm it to your administrator e-mail address.</LegalLi>
              <LegalLi>Subscription Fees are as published or quoted, exclusive of applicable value-added tax, withholding tax and similar levies, which you are responsible for paying where law requires.</LegalLi>
              <LegalLi>Unless otherwise stated on the order form, fees for a subscription period are invoiced in advance and are payable within the stated payment period (default: fourteen (14) days) from the invoice date.</LegalLi>
              <LegalLi>You may upgrade your Plan at any time; upgrades take effect when confirmed, and any pro-rata adjustment is set out in the confirmation. Downgrades take effect at the end of the then-current subscription period.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="7.3" title="Renewal, non-payment and price changes">
          <LegalList
            >
              <LegalLi>Subscriptions renew automatically for successive periods of the same length unless terminated in accordance with Section 20.</LegalLi>
              <LegalLi>If fees remain unpaid after their due date, we may suspend the Workspace after giving you at least seven (7) days' written notice, and ultimately terminate under Section 20. Suspension for non-payment does not delete Customer Data during the notice periods stated in Section 21.</LegalLi>
              <LegalLi>We may change Subscription Fees for a new subscription period or on renewal by giving you at least thirty (30) days' written notice. If you do not accept a price change, you may terminate the subscription before it takes effect and receive a pro-rata refund of prepaid, unused fees for the terminated period.</LegalLi></LegalList>
        </LegalSub>
      </LegalSection>

      {/* ── 8 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={8} title="Quotas and Fair Use">
        <LegalP>
          The Service is shared infrastructure. In addition to published quotas, you must not use
          the Service in a manner that imposes a disproportionate or unreasonably burdensome load
          on it — including volumetric document generation clearly beyond ordinary business use,
          automated scraping of the Service, credential-stuffing, or deliberate circumvention of
          rate limits, quotas or protective controls.
        </LegalP>
        <LegalP>
          Where we reasonably determine that usage materially exceeds ordinary business use, we
          may throttle or restrict the affected functions and contact your administrator to
          discuss an appropriate Plan. This Section does not limit our rights under Sections 9 and
          20.
        </LegalP>
      </LegalSection>

      {/* ── 9 ─────────────────────────────────────────────────────────── */}
      <LegalSection n={9} title="Acceptable Use Policy">
        <LegalP>You must not, and must not permit any Authorised User to:</LegalP>
        <LegalList
          >
            <LegalLi>use the Service for any purpose that is unlawful, fraudulent, deceptive or misleading, or in violation of any applicable law, regulation, court order, or sanctions or export-control measure;</LegalLi>
            <LegalLi>upload, store or distribute content that infringes any intellectual-property right, breach of confidence, or privacy right of any person;</LegalLi>
            <LegalLi>transmit malware, attempt to gain unauthorised access to the Service, other Customers' Workspaces, our infrastructure or any connected system (including by probing, scanning or testing vulnerabilities without our prior written authorisation);</LegalLi>
            <LegalLi>interfere with or disrupt the integrity or performance of the Service, including by exceeding stated rate limits or circumventing technical protection measures;</LegalLi>
            <LegalLi>reverse-engineer, decompile, disassemble or attempt to derive the source code, algorithms or non-public APIs of the Service except to the extent that such activity cannot be prohibited by applicable law;</LegalLi>
            <LegalLi>resell, sublicense, lease or otherwise provide the Service to third parties as a hosted or managed service without a written agreement with us;</LegalLi>
            <LegalLi>create accounts or Workspace registrations under false or borrowed identity, or misrepresent your affiliation with any person or entity;</LegalLi>
            <LegalLi>use the KYC document-exchange or portal features to transmit content that is obscene, defamatory, threatening, or that harasses or intimidates any person; or</LegalLi>
            <LegalLi>use the Service to store personal data of data subjects who have no relationship with you, or that you are otherwise not lawfully permitted to process.</LegalLi></LegalList>
        <LegalP>
          We may investigate suspected violations and may suspend an account or Workspace
          immediately where reasonably necessary to protect the Service, other Customers or
          third parties (Section 20). Report suspected abuse to {O.contactEmail}.
        </LegalP>
      </LegalSection>

      {/* ── 10 ────────────────────────────────────────────────────────── */}
      <LegalSection n={10} title="Trade, Sanctions and Export-Control Compliance">
        <LegalP>
          The Service supports international trade operations, which are subject to strict
          sanctions, export-control and customs regimes. This Section allocates the compliance
          burden clearly: <strong>we operate the software; you own the trade.</strong>
        </LegalP>
        <LegalList
          ordered
          >
            <LegalLi>
              <strong>Your responsibilities.</strong> You are solely responsible for ensuring that
              your business, transactions, counterparties, goods and destinations comply with all
              applicable sanctions laws (including those administered by the United Nations, the
              European Union, the United States Department of the Treasury&rsquo;s Office of
              Foreign Assets Control (OFAC), and the United Kingdom Office of Financial Sanctions
              Implementation (OFSI)), export-control and dual-use regulations, customs rules, and
              anti-boycott laws. This includes screening your counterparties and obtaining any
              licences, permits or filings required for your transactions.
            </LegalLi>
            <LegalLi>
              <strong>Representations.</strong> You represent and warrant, on a continuing basis,
              that: (a) neither you, your beneficial owners, nor any counterparty you record in
              the Service is a person or entity designated on any applicable sanctions or
              restricted-party list; (b) your use of the Service is not located in, or destined
              for, any country or territory subject to comprehensive sanctions to the extent such
              use is prohibited; and (c) the goods and services you trade are not prohibited or
              restricted for export or re-export to their destinations.
            </LegalLi>
            <LegalLi>
              <strong>Our rights.</strong> We may perform sanctions and restricted-party screening
              of registration data and of counterparty records processed through the Service, and
              we may require KYC documentation. Where a screening result, competent-authority
              instruction or reasonable suspicion indicates a possible violation, we may suspend
              or terminate the affected Workspace without liability and, where legally required,
              report to the competent authorities.
            </LegalLi>
            <LegalLi>
              <strong>No licence.</strong> Nothing in these Terms or in the Service constitutes an
              export licence, sanctions clearance, legal opinion or customs advice. No feature of
              the Service (including any screening, margin or document-generation function)
              relieves you of your own compliance obligations.
            </LegalLi>
          </LegalList>
      </LegalSection>

      {/* ── 11 ────────────────────────────────────────────────────────── */}
      <LegalSection n={11} title="Anti-Bribery and Anti-Money-Laundering">
        <LegalList
          >
            <LegalLi>You must not use the Service in connection with any offer, promise, payment or gift intended to improperly influence a public official or any other person, in violation of applicable anti-bribery or anti-corruption laws.</LegalLi>
            <LegalLi>You must not use the Service to plan, document or disguise proceeds of crime, to evade tax, or to facilitate money laundering or terrorist financing.</LegalLi>
            <LegalLi>The Service is a records and document-management system. It is not a payment institution, bank, money-service business or escrow agent, and no feature of the Service effects the transmission of funds. Payment arrangements between you and your counterparties are entirely your own.</LegalLi>
            <LegalLi>Where we have a reasonable suspicion or a legal obligation, we may suspend the affected Workspace and make legally required disclosures to competent authorities, and we will do so without prior notice to you where the law prohibits tipping-off.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 12 ────────────────────────────────────────────────────────── */}
      <LegalSection n={12} title="Customer Data and Customer Responsibilities">
        <LegalSub n="12.1" title="Your data, your responsibility">
          <LegalList
            >
              <LegalLi>You retain all right, title and interest in and to Customer Data. Subject to these Terms, we process Customer Data on your behalf strictly to provide the Service (Section 22 and the Privacy Policy).</LegalLi>
              <LegalLi>You are responsible for the lawfulness of the data you submit; the accuracy, completeness and authenticity of business and KYC documents you upload; and for obtaining any consents required from your counterparties and portal users for the processing you direct.</LegalLi>
              <LegalLi>You must keep backups of material records outside the Service where appropriate for your business. The Service is a system of record, but it is not a substitute for your own information-governance and archival obligations.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="12.2" title="Generated documents">
          <LegalP>
            Offer, invoice, proforma, letter-of-intent and other documents generated in the
            Service are drafted from the data and templates you supply. You are responsible for
            reviewing and validating every document before sending or executing it. We do not
            verify the legal sufficiency, tax treatment or regulatory conformity of generated
            documents (Section 17).
          </LegalP>
        </LegalSub>
        <LegalSub n="12.3" title="Portal content">
          <LegalP>
            Where you invite counterparties to the client portal, you remain responsible for their
            entitlement to access the documents and data you share with them, and for the
            lawfulness of sharing that information with them. Portal users are bound by the
            portal-specific terms presented to them.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 13 ────────────────────────────────────────────────────────── */}
      <LegalSection n={13} title="Intellectual Property">
        <LegalSub n="13.1" title="Our property">
          <LegalP>
            The Service, including its software, code, architecture, design, layouts, templates
            (other than the content of templates you create), documentation, trademarks, trade
            names and logos, is and remains the exclusive property of {O.legalEntity} and its
            licensors. No ownership or intellectual-property right transfers to you under these
            Terms, except the limited right of use expressly granted in Section 4.
          </LegalP>
        </LegalSub>
        <LegalSub n="13.2" title="Feedback">
          <LegalP>
            If you submit suggestions, feature requests or feedback regarding the Service, you
            grant us a perpetual, irrevocable, worldwide, royalty-free licence to use, implement
            and commercialise that feedback without restriction or attribution.
          </LegalP>
        </LegalSub>
        <LegalSub n="13.3" title="Trademarks">
          <LegalP>
            &ldquo;VELOS&rdquo; and related marks are our trademarks. You must not use them (other
            than to identify the Service in ordinary business correspondence) without our prior
            written consent, and you must not remove or obscure proprietary notices in the Service
            or in generated documents where the law requires their preservation.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 14 ────────────────────────────────────────────────────────── */}
      <LegalSection n={14} title="Confidentiality">
        <LegalList
          >
            <LegalLi>Each party may receive information that the other treats as confidential (including pricing, business records, security configurations, product roadmaps and these negotiations). Each party must keep the other's confidential information secret, use it only to exercise rights and perform obligations under these Terms, and protect it with at least the care it applies to its own confidential information.</LegalLi>
            <LegalLi>These obligations do not apply to information that is or becomes public without breach, was already lawfully known, is independently developed without use of the other's information, or must be disclosed by law or a competent authority — provided the disclosing party gives the other prompt notice where legally permitted.</LegalLi>
            <LegalLi>Customer Data is your confidential information and is additionally protected by Section 22 and the Privacy Policy.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 15 ────────────────────────────────────────────────────────── */}
      <LegalSection n={15} title="Third-Party Services and Integrations">
        <LegalList
          >
            <LegalLi>The Service relies on third-party infrastructure and processors (including hosting, database and e-mail delivery providers) engaged under data-processing arrangements described in the Privacy Policy.</LegalLi>
            <LegalLi>Where the Service offers integrations with third-party systems or public APIs (including any API keys and webhooks issued to your Workspace), you use them at your own risk. We are not a party to your arrangement with the third-party provider and make no warranty regarding its service.</LegalLi>
            <LegalLi>You must keep API keys and webhook secrets secured. Keys issued to your Workspace may be rotated or revoked by us when compromised, or when reasonably necessary for security.</LegalLi>
            <LegalLi>Availability of any third-party integration is not guaranteed and does not form part of the Service&rsquo;s core functionality for the purposes of Section 16 or 18.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 16 ────────────────────────────────────────────────────────── */}
      <LegalSection n={16} title="Service Availability and Support">
        <LegalSub n="16.1" title="Availability">
          <LegalP>
            We aim for high availability and monitor the Service continuously. However, we do not
            commit to a specific uptime percentage under these Terms. The Service may be
            unavailable for planned maintenance (announced where reasonably practicable),
            emergency fixes, or causes beyond our reasonable control (Section 26).
          </LegalP>
        </LegalSub>
        <LegalSub n="16.2" title="Backups and recovery">
          <LegalP>
            We operate reasonable backup and recovery procedures for the Service as a whole. We
            do not provide per-Workspace point-in-time recovery, and our backup obligations do
            not substitute for your own records-management duties (Section 12).
          </LegalP>
        </LegalSub>
        <LegalSub n="16.3" title="Support">
          <LegalP>
            Support requests are directed to the channels published in the Service or to{" "}
            {O.contactEmail}. Response times for paid Plans are as stated in the order form or
            published plan description, if any. Trial support is provided on a reasonable-efforts
            basis.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 17 ────────────────────────────────────────────────────────── */}
      <LegalSection n={17} title="Disclaimers">
        <LegalP>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; for the
          purpose of managing trade records and documents. To the maximum extent permitted by
          applicable law, and without limiting Section 18, we disclaim all conditions, warranties
          and representations of any kind, express or implied, in relation to the Service,
          including merchantability, fitness for a particular purpose, non-infringement, and
          accuracy or completeness of data or calculations.
        </LegalP>
        <LegalP>Without limitation of the foregoing, the following specifically applies:</LegalP>
        <LegalList
          >
            <LegalLi>Landed-cost, margin, pricing and currency figures produced by the Service are estimates computed from the inputs you supply; they are not quotations, valuations, customs classifications or tax advice.</LegalLi>
            <LegalLi>Generated documents are drafts until reviewed, approved and (where applicable) executed by you; we make no representation that any template or document satisfies the legal, fiscal or regulatory requirements of any jurisdiction.</LegalLi>
            <LegalLi>KYC document handling assists your own diligence; it is not a verification, audit or certification of any counterparty.</LegalLi>
            <LegalLi>We do not warrant that the Service will be error-free, uninterrupted, secure against all attack vectors, or compatible with every browser, device or third-party system.</LegalLi></LegalList>
        <LegalP>
          Nothing in these Terms excludes liability that cannot lawfully be excluded, including
          liability for fraud or fraudulent misrepresentation.
        </LegalP>
      </LegalSection>

      {/* ── 18 ────────────────────────────────────────────────────────── */}
      <LegalSection n={18} title="Limitation of Liability">
        <LegalSub n="18.1" title="Aggregate cap">
          <LegalP>
            To the maximum extent permitted by applicable law, our total aggregate liability
            arising out of or relating to these Terms or the Service, however arising (including
            in contract, tort, breach of statutory duty or otherwise), is capped at the{" "}
            <strong>greater of</strong> (a) the total Subscription Fees actually paid by you to
            us in the twelve (12) months immediately preceding the first event giving rise to
            liability, and (b) <strong>USD 100</strong> (for Customers on the Trial Period or any
            free tier).
          </LegalP>
        </LegalSub>
        <LegalSub n="18.2" title="Exclusions">
          <LegalP>
            Nothing in these Terms limits or excludes liability for death or personal injury
            caused by negligence, for fraud or fraudulent misrepresentation, for willful
            misconduct or gross negligence, for any liability that cannot lawfully be limited
            under applicable mandatory law, or (where you are a consumer dealing with us as such
            — which is not the intended use of the Service) for your statutory consumer rights.
          </LegalP>
        </LegalSub>
        <LegalSub n="18.3" title="Excluded losses">
          <LegalP>
            Subject to Section 18.2, neither party is liable for loss of profit, revenue,
            goodwill, business opportunity or anticipated savings; loss or corruption of data
            (other than caused by our breach of these Terms); or indirect, special, incidental,
            punitive or consequential loss — even if advised of the possibility and even if a
            remedy fails of its essential purpose.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 19 ────────────────────────────────────────────────────────── */}
      <LegalSection n={19} title="Indemnification">
        <LegalP>
          You will defend, indemnify and hold harmless {O.legalEntity}, its officers, employees
          and agents from and against any third-party claim, and resulting damages, liabilities,
          costs and reasonable expenses (including legal fees), arising from: (a) your Customer
          Data, including any claim that it infringes a third party&rsquo;s rights or breaches
          privacy or data-protection law; (b) your use of the Service in violation of these
          Terms, of applicable law, or of any sanctions or export-control measure; (c) your trade
          in transactions documented in the Service, including product liability and customs
          claims; or (d) your breach of the representations in Sections 3 and 10.
        </LegalP>
        <LegalP>
          We will defend, indemnify and hold harmless you against any third-party claim that the
          Service, as provided by us and used in accordance with these Terms, infringes a third
          party&rsquo;s intellectual-property rights, provided you notify us promptly, allow us
          to control the defence, and cooperate reasonably. If the Service becomes or is likely
          to become the subject of such a claim, we may procure the right for you to continue
          using it, modify it to be non-infringing, or terminate your subscription and refund
          prepaid, unused fees pro-rata.
        </LegalP>
      </LegalSection>

      {/* ── 20 ────────────────────────────────────────────────────────── */}
      <LegalSection n={20} title="Term, Suspension and Termination">
        <LegalSub n="20.1" title="Term">
          <LegalP>
            These Terms apply from acceptance and continue for as long as you hold an active
            Workspace, including any Trial Period and paid subscription periods, until terminated
            as set out below.
          </LegalP>
        </LegalSub>
        <LegalSub n="20.2" title="Termination for convenience">
          <LegalP>
            You may terminate at any time from the Workspace settings (which deactivates your
            subscription) or by written notice to {O.contactEmail}. Termination takes effect
            immediately on deactivation, subject to the data-retrieval window in Section 21.
            Prepaid, unused fees for the terminated period are refunded pro-rata where the
            termination occurs during a paid period and we do not apply an earlier suspension
            right.
          </LegalP>
        </LegalSub>
        <LegalSub n="20.3" title="Termination and suspension by us">
          <LegalList
            >
              <LegalLi>We may suspend your Workspace immediately, without prior notice, where reasonably necessary to: (a) address a security incident or ongoing attack; (b) comply with a sanctions, export-control or other legal instruction; (c) stop a breach of Sections 9 to 11 that is causing or is likely to cause harm; or (d) protect the integrity of the Service or other Customers.</LegalLi>
              <LegalLi>We may terminate these Terms on written notice with immediate effect for a material breach that is incapable of remedy, or that you fail to remedy within fourteen (14) days of a notice describing it; and with thirty (30) days' notice for any other lawful reason, in which case prepaid, unused fees are refunded pro-rata.</LegalLi>
              <LegalLi>Expiry of a Trial Period or subscription without renewal results in suspension of the Workspace under Section 6.3 or 7.3 respectively, followed by deletion in accordance with Section 21.</LegalLi></LegalList>
        </LegalSub>
        <LegalSub n="20.4" title="Survival">
          <LegalP>
            Sections 1, 9, 10, 11, 12, 13, 14, 17, 18, 19, 21, 22 (as to processing on our side),
            23, 25, 26 and any accrued rights survive termination.
          </LegalP>
        </LegalSub>
      </LegalSection>

      {/* ── 21 ────────────────────────────────────────────────────────── */}
      <LegalSection n={21} title="Effect of Termination; Data Retrieval">
        <LegalList
          ordered
          >
            <LegalLi>
              Upon suspension or termination, your access to the Service ceases, but Customer
              Data is <strong>not</strong> deleted immediately. We retain Customer Data in a
              read-protected state for a retrieval window of at least <strong>ninety (90)
              days</strong> from suspension or termination (the &ldquo;Retrieval Window&rdquo;),
              so that you can export it.
            </LegalLi>
            <LegalLi>
              During the Retrieval Window you may request a structured export of Customer Data
              (including partner, offer, deal, invoice and document records) by writing to{" "}
              {O.contactEmail} from your administrator e-mail address. We aim to deliver exports
              in a machine-readable format within a reasonable period, and we may charge a
              reasonable fee for exceptionally large or repeated exports.
            </LegalLi>
            <LegalLi>
              After the Retrieval Window, we may delete Customer Data in the ordinary course of
              our retention schedule (Privacy Policy, Section 8), save where a longer retention
              period is required by law (for example, accounting or anti-money-laundering
              record-keeping).
            </LegalLi>
            <LegalLi>
              Certificates, audit-trail entries and security records relating to the account are
              retained for the periods stated in the Privacy Policy and are not part of the
              export.
            </LegalLi>
          </LegalList>
      </LegalSection>

      {/* ── 22 ────────────────────────────────────────────────────────── */}
      <LegalSection n={22} title="Data Protection and Privacy">
        <LegalList
          >
            <LegalLi>Our collection and processing of personal data in connection with the Service is governed by the VELOS Privacy Policy (ref " + "VELOS-LEGAL-PRIV" + "), which forms part of these Terms. Where you act as a controller of personal data processed through the Service, you remain responsible for your own compliance with applicable data-protection law.</LegalLi>
            <LegalLi>Where required by applicable data-protection law, we will enter into a data-processing agreement with you on request covering the processing of personal data we carry out on your instructions; contact " + O.privacyEmail + ".</LegalLi>
            <LegalLi>You must not upload special categories of personal data (as defined in applicable data-protection law) to the Service except where you are legally permitted to do so, and you remain the controller for such data.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 23 ────────────────────────────────────────────────────────── */}
      <LegalSection n={23} title="Notices and Communications">
        <LegalList
          >
            <LegalLi>Notices from us are delivered by e-mail to your Workspace administrator address or delivered in the Service (in-app notification). E-mail notices are deemed received twenty-four (24) hours after sending if the address does not produce a delivery failure.</LegalLi>
            <LegalLi>Notices from you must be sent in writing to " + O.contactEmail + " (general and legal) or " + O.privacyEmail + " (data protection), and are deemed received on our confirmed acknowledgement, or on delivery where sent by a trackable method.</LegalLi>
            <LegalLi>Operational messages (password resets, security alerts, trial and subscription status) are sent by e-mail and are not legal notices.</LegalLi></LegalList>
      </LegalSection>

      {/* ── 24 ────────────────────────────────────────────────────────── */}
      <LegalSection n={24} title="Amendments to These Terms">
        <LegalList
          ordered
          >
            <LegalLi>
              We may amend these Terms from time to time. The version in force is the one
              published at /legal/terms with its version number and effective date. Material
              amendments (including changes to Sections 6 to 11, 17, 18, 20, 21 or 25) are
              announced to your administrator e-mail address at least thirty (30) days before
              they take effect.
            </LegalLi>
            <LegalLi>
              Your continued use of the Service after the effective date of an amendment
              constitutes acceptance of the amended Terms. If you do not accept a material
              amendment, you may terminate before it takes effect under Section 20.2; prepaid,
              unused fees are refunded pro-rata.
            </LegalLi>
            <LegalLi>
              Every acceptance we record in the audit trail (Section 2.3) identifies the version
              accepted, so the version binding your Workspace can always be established. The
              version binding you at any moment is the version you last accepted or, where later,
              the version you were notified of and did not reject within the notice period.
            </LegalLi>
          </LegalList>
      </LegalSection>

      {/* ── 25 ────────────────────────────────────────────────────────── */}
      <LegalSection n={25} title="Governing Law and Dispute Resolution">
        <LegalList
          ordered
          >
            <LegalLi>
              These Terms and any dispute or claim arising out of or in connection with them or
              their subject matter or formation are governed by the laws of the United Arab
              Emirates as applied in the Dubai International Financial Centre (&ldquo;DIFC&rdquo;),
              without regard to its conflict-of-laws rules.
            </LegalLi>
            <LegalLi>
              The parties will first attempt in good faith to resolve any dispute by negotiation
              between senior representatives within thirty (30) days of a written notice of
              dispute. Either party may initiate mediation administered by the DIFC Courts before
              litigating, and both parties agree to attend mediation in good faith if invited.
            </LegalLi>
            <LegalLi>
              Subject to Sections 25.2 and 25.4, the DIFC Courts have exclusive jurisdiction over
              any dispute arising out of these Terms, and each party irrevocably submits to that
              jurisdiction and waives any objection based on venue or inconvenient forum.
            </LegalLi>
            <LegalLi>
              <strong>Consumers and mandatory local law.</strong> Nothing in this Section deprives
              a natural person acting as a consumer of the protection of the mandatory consumer
              and data-protection provisions of the country in which they are habitually resident,
              including the right to bring proceedings in that country where applicable law so
              provides, or limits any statutory right to lodge a complaint with a competent
              supervisory authority.
            </LegalLi>
          </LegalList>
      </LegalSection>

      {/* ── 26 ────────────────────────────────────────────────────────── */}
      <LegalSection n={26} title="Miscellaneous Provisions">
        <LegalTable
          head={["Provision", "Effect"]}
          rows={[
            [
              "Entire agreement",
              "These Terms, the Privacy Policy and any signed order form are the entire agreement between the parties regarding the Service, and supersede all prior understandings regarding it. No other terms apply (Section 2.4).",
            ],
            [
              "Independent contractors",
              "The parties are independent contractors. Nothing in these Terms creates a partnership, agency, employment or joint venture.",
            ],
            [
              "Assignment",
              "You may not assign these Terms without our prior written consent (not to be unreasonably withheld — including in a merger or sale of substantially all assets, where you must still notify us). We may assign to a successor of all or part of our business with notice to you.",
            ],
            [
              "Force majeure",
              "Neither party is liable for failure or delay caused by circumstances beyond its reasonable control, including natural disasters, war, civil unrest, sanctions, acts of government, labour disputes, failure of utilities or the public internet, or third-party cloud-provider outages. The affected party must notify the other and mitigate reasonably; if the event continues for more than thirty (30) days, either party may terminate on written notice.",
            ],
            [
              "Severability and waivers",
              "If any provision is held unenforceable, it is modified to the minimum extent necessary or severed, and the remainder continues in force. A failure or delay to enforce a right is not a waiver of it.",
            ],
            [
              "Language",
              "These Terms are drawn up in English. Any translation is for convenience only; the English text (version " + TERMS_OF_SERVICE.version + ") alone is authoritative (Section 1 interpretation and the notice on the cover of this document).",
            ],
            [
              "Statutory references",
              "References to laws include UAE Federal legislation and DIFC law as applicable, and equivalent foreign legislation where the context requires.",
            ],
          ]}
        />
        <LegalP>
          Questions regarding these Terms: <strong>{O.contactEmail}</strong>. Data-protection
          questions: <strong>{O.privacyEmail}</strong>.
        </LegalP>
      </LegalSection>
    </>
  );
}
