#!/usr/bin/env python3
"""
Merge missing Serbian translations into src/lib/i18n/domains/crm.ts.

Strategy:
1. Read the file
2. Find EN and SR section boundaries
3. Within each, find the "─── Partners, Deals, Offers, Demands, Partner-360 views ───"
   sub-section (up to the "── partner-picker ──" marker)
4. Use the EN sub-section as the template (preserving comments + structure)
5. For each key in EN order:
   - If key exists in current SR: use SR value (preserves existing translations)
   - Else: use the Serbian translation from the TRANSLATIONS dict
6. Replace the SR sub-section with the merged result
"""

import re
from pathlib import Path

FILE = Path('/home/z/aspidusReady/src/lib/i18n/domains/crm.ts')

# ─── Serbian (Latin) translations for the 342 missing CRM keys ────────────────
TRANSLATIONS = {
    "crm-transferred-fields-desc": "Automatski sinhronizovano sa zapisom partnera pri odobrenju",
    "crm-partner-updated": "Partner ažuriran.",
    "crm-partner-deleted": "Partner obrisan.",
    "crm-partner-details": "Detalji partnera",
    "crm-partner-required-label": "Partner *",
    "crm-select-a-partner": "Izaberite partnera",
    "crm-select-a-partner-toast": "Izaberite partnera.",
    "crm-auto-filled": "Automatski popunjeno",
    "crm-save-changes": "Sačuvaj izmene",
    "crm-create-partner": "Kreiraj partnera",
    "crm-saving-ellipsis": "Čuvanje…",
    "crm-saving-failed-toast": "Čuvanje nije uspelo.",
    "crm-search-by-name-email-phone": "Pretraga po imenu, emailu ili telefonu…",
    "crm-delete-partner-title": "Obrisati partnera?",
    "crm-delete-partner-desc": "Ova radnja se ne može poništiti. Povezane ponude i poslovi mogu izgubiti referencu.",
    "crm-portal-access-toggle": "Portalski pristup",
    "crm-portal-access-toggle-desc": "Dozvoli partnerski pristup portalu.",
    "crm-commission-agent-section": "Komisioni agent",
    "crm-commission-agent-desc": "Označi ovog partnera kao komisionog agenta koji zarađuje od poslova koje preporuči.",
    "crm-address-trade": "Adresa i trgovina",
    "crm-notes-options": "Napomene i opcije",
    "crm-vat-prefix": "PDV: ${value}",
    "crm-currency-prefix": "Valuta: ${value}",
    "crm-incoterm-prefix": "Incoterm: ${value}",
    "crm-terms-prefix": "Uslovi: ${value}",
    "crm-tax-id-prefix": "PIB: ${value}",
    "crm-stage-lead": "Potencijal",
    "crm-stage-qualified": "Kvalifikovan",
    "crm-stage-proposal": "Predlog",
    "crm-stage-negotiation": "Pregovori",
    "crm-stage-won": "Dobijen",
    "crm-stage-lost": "Izgubljen",
    "crm-stage": "Faza",
    "crm-title": "Naslov",
    "crm-title-required-label": "Naslov *",
    "crm-title-required": "Naslov je obavezan.",
    "crm-value": "Vrednost",
    "crm-probability": "Verovatnoća",
    "crm-expected-close": "Očekivano zatvaranje",
    "crm-expected-close-label": "Očekivano zatvaranje",
    "crm-pipeline-view": "Pregled prodora",
    "crm-table-view": "Tablični pregled",
    "crm-pipeline": "Prodor",
    "crm-table": "Tabela",
    "crm-no-deals-pipeline": "Nema poslova.",
    "crm-search-by-title": "Pretraga po naslovu…",
    "crm-delete-deal-title": "Obrisati posao?",
    "crm-delete-deal-desc": "Ova radnja se ne može poništiti. Povezane ponude mogu izgubiti referencu.",
    "crm-edit-deal": "Izmeni posao",
    "crm-update-deal-details": "Ažurirajte detalje posla ispod.",
    "crm-create-deal-desc": "Počnite od osnova — proširite sekcije za više opcija.",
    "crm-deal-updated": "Posao ažuriran.",
    "crm-deal-created": "Posao \\\"${title}\\\" kreiran.",
    "crm-added-to-pipeline": "Dodato u vaš prodor.",
    "crm-auto-staged-qualified": "Automatski prebačeno u \\\"Kvalifikovan\\\"",
    "crm-auto-filled-from-partner": "Automatski popunjeno iz partnera",
    "crm-hide-details": "Sakrij detalje",
    "crm-show-details": "Prikaži detalje",
    "crm-no-historical-data-partner": "Nema istorijskih podataka za ovog partnera.",
    "crm-recent-deals": "Skorašnji poslovi",
    "crm-recent-offers": "Skorašnje ponude",
    "crm-recent-deals-won": "Skorašnji poslovi (${won}/${total} dobijeno)",
    "crm-probability-close-date-notes": "Verovatnoća, datum zatvaranja, napomene",
    "crm-suggested-for": "Predloženo za",
    "crm-costs-pricing": "Troškovi i cene",
    "crm-costs-pricing-desc": "Količina, nabavna cena, provizije, FX, dobit",
    "crm-unit-of-measure": "Jedinica mere",
    "crm-exchange-rate": "Kurs",
    "crm-exchange-rate-desc": "Multiplikator primenjen na ukupni trošak (prodajna valuta po nabavnoj valuti).",
    "crm-buy-cost-total": "Nabavna cena (ukupno)",
    "crm-purchase-currency": "Valuta nabavke",
    "crm-selling-price-total": "Prodajna cena (ukupno)",
    "crm-selling-price-desc": "Ako je 0, vrednost posla se koristi kao prodajna cena.",
    "crm-selling-currency": "Prodajna valuta",
    "crm-bank-costs": "Bankovni troškovi",
    "crm-other-costs": "Ostali troškovi",
    "crm-profit-margin-preview": "Pregled dobiti i marže",
    "crm-commission-section": "Provizija",
    "crm-commission-section-desc": "Agent, tip, vrednost",
    "crm-commission-agent": "Komisioni agent",
    "crm-no-commission-agent": "Bez komisionog agenta",
    "crm-estimated-commission": "Procenjena provizija",
    "crm-deal-value": "Vrednost posla",
    "crm-deal-profit": "Dobit posla",
    "crm-quantity-label": "Količina",
    "crm-lost-reason": "Razlog gubitka",
    "crm-create-deal": "Kreiraj posao",
    "crm-quick-stage-change": "Brza promena faze",
    "crm-deal-details-card": "Detalji posla",
    "crm-partner-quick-stats": "Brze statistike partnera",
    "crm-total-value": "Ukupna vrednost",
    "crm-win-rate": "Stopa dobitka",
    "crm-avg-deal": "Prosečan posao",
    "crm-create-offer-from-deal": "Kreiraj ponudu iz posla",
    "crm-this-deal-already-offer": "Ovaj posao već ima povezanu ponudu",
    "crm-auto-create-offer-desc": "Automatski kreiraj ponudu u nacrtu iz ovog posla sa svim partnerskim detaljima unapred popunjenim.",
    "crm-creating-ellipsis": "Kreiranje…",
    "crm-offer-created-from-deal": "Ponuda kreirana iz posla!",
    "crm-offer-created-from-deal-desc": "Ponuda ${number} je kreirana.",
    "crm-view-offer": "Pogledaj ponudu",
    "crm-failed-create-offer-from-deal": "Kreiranje ponude iz posla nije uspelo.",
    "crm-stage-changed-to": "Faza promenjena u ${stage}.",
    "crm-stage-change-failed": "Promena faze nije uspela.",
    "crm-margin-label": "Marža",
    "crm-profit": "Dobit",
    "crm-total-cost": "Ukupni trošak",
    "crm-commission": "Provizija",
    "crm-same-as-deal-currency": "Isto kao valuta posla",
    "crm-deal": "Posao",
    "crm-deal-details": "Detalji posla",
    "crm-deal-deleted": "Posao obrisan.",
    "crm-offer": "Ponuda",
    "crm-offer-details": "Detalji ponude",
    "crm-demand": "Zahtev",
    "crm-demand-details": "Detalji zahteva",
    "crm-demand-deleted": "Zahtev obrisan.",
    "crm-demand-updated": "Zahtev ažuriran.",
    "crm-demand-created": "Zahtev kreiran!",
    "crm-demand-created-from-rfq": "Zahtev kreiran iz RFQ-a ${number}",
    "crm-failed-convert-demand-offer": "Konverzija zahteva u ponudu nije uspela",
    "crm-offer-created-prefix": "Ponuda kreirana: ${number}",
    "crm-failed-create-demand": "Kreiranje zahteva nije uspelo",
    "crm-failed-create-demand-from-rfq": "Kreiranje zahteva iz RFQ-a nije uspelo.",
    "crm-create-demand-from-portal-rfq": "Kreiraj zahtev iz portalskog RFQ-a",
    "crm-create-demand-from-portal-rfq-desc": "Izaberite portalski RFQ na čekanju da automatski kreirate zahtev. Podaci o partneru i proizvodu biće automatski popunjeni.",
    "crm-no-pending-portal-rfqs": "Nema dostupnih portalskih RFQ-ova na čekanju.",
    "crm-target": "Cilj",
    "crm-create-btn": "Kreiraj",
    "crm-delete-demand-title": "Obrisati zahtev?",
    "crm-delete-demand-desc": "Ova radnja se ne može poništiti. Zahtev i njegove stavke biće trajno obrisani.",
    "crm-edit-demand": "Izmeni zahtev",
    "crm-update-demand-details": "Ažurirajte detalje zahteva ispod.",
    "crm-create-demand-desc": "Popunite osnovne podatke da kreirate zahtev. Proširite sekcije za više opcija.",
    "crm-auto-generated-number": "Automatski generisan broj",
    "crm-partner-data-loaded": "Podaci o partneru učitani: ${name}",
    "crm-currency-prefs-auto-filled": "Valuta i preference automatski popunjene.",
    "crm-failed-load-partner-context": "Učitavanje konteksta partnera nije uspelo.",
    "crm-product-data-loaded": "Podaci o proizvodu učitani: ${name}",
    "crm-price-unit-currency-auto-filled": "Cena, jedinica i valuta automatski popunjene.",
    "crm-convert-to-offer": "Konvertuj u ponudu",
    "crm-demand-new-lower": "Novi zahtev",
    "crm-equipment-inquiry-ph": "Upit za opremu",
    "crm-notes-description": "Napomene / Opis",
    "crm-additional-notes-placeholder": "Dodatne napomene ili zahtevi…",
    "crm-source-portal-rfq": "Portalski RFQ",
    "crm-source-manual": "Ručno",
    "crm-source-import": "Uvoz",
    "crm-delivery-city-country": "Grad isporuke/država",
    "crm-bank-name-iban": "Naziv banke · IBAN",
    "crm-subject-currency-etc": "Subjekt, valuta, isporuka, napomene, stavke…",
    "crm-create-demand": "Kreiraj zahtev",
    "crm-number": "Broj",
    "crm-subject": "Subjekt",
    "crm-priority": "Prioritet",
    "crm-items": "Stavke",
    "crm-no-items": "Nema stavki.",
    "crm-target-price": "Ciljna cena",
    "crm-target-price-label": "Ciljna cena",
    "crm-trade-details": "Trgovinski detalji",
    "crm-new-product-trade": "Novi proizvod",
    "crm-source": "Izvor",
    "crm-destination": "Destinacija",
    "crm-needed-by": "Potrebno do",
    "crm-buyer-bank": "Banka kupca",
    "crm-auto-hints": "Automatski predlozi",
    "crm-requested-delivery": "Tražena isporuka",
    "crm-requested-delivery-label": "Tražena isporuka",
    "crm-line-items": "Stavke",
    "crm-add-item": "Dodaj stavku",
    "crm-qty": "Kol.",
    "crm-product-name-ph": "Naziv proizvoda",
    "crm-select-product-item": "Izaberite proizvod",
    "crm-from-portal-rfq": "Iz portalskog RFQ-a",
    "crm-from-deal": "Iz posla",
    "crm-search-by-number-subject": "Pretraga po broju, subjektu…",
    "crm-valid-until-label": "Važi do",
    "crm-select-all-on-page-label": "Izaberi sve na stranici",
    "crm-offer-selected": "ponuda izabrana",
    "crm-offers-selected": "ponuda izabrano",
    "crm-send-all": "Pošalji sve",
    "crm-create-offer-from-deal-dialog": "Kreiraj ponudu iz posla",
    "crm-create-offer-from-deal-desc": "Izaberite posao da automatski kreirate ponudu sa svim podacima o partneru i proizvodu unapred popunjenim.",
    "crm-search-deals": "Pretraga poslova…",
    "crm-no-deals-found": "Poslovi nisu pronađeni.",
    "crm-change-status": "Promeni status",
    "crm-move-to": "Premesti u",
    "crm-save-version": "Sačuvaj verziju",
    "crm-save-new-version": "Sačuvaj novu verziju",
    "crm-create-invoice": "Kreiraj fakturu",
    "crm-create-proforma": "Kreiraj predračun",
    "crm-valid-until-detail": "Važi do",
    "crm-sent-detail": "Poslato",
    "crm-responded": "Odgovoreno",
    "crm-supplier-ref": "Referenca dobavljača",
    "crm-incoterm-detail": "Incoterm",
    "crm-payment-terms-detail": "Uslovi plaćanja",
    "crm-port-of-loading": "Luka utovara",
    "crm-port-of-discharge": "Luka istovara",
    "crm-vessel": "Brod",
    "crm-container-no": "Kontejner br.",
    "crm-lead-time-detail": "Rok isporuke",
    "crm-packaging-detail": "Pakovanje",
    "crm-tax-clause": "Klauzula o porezu",
    "crm-selling-price-detail": "Prodajna cena",
    "crm-sku-detail": "SKU",
    "crm-quantity-detail": "Količina",
    "crm-unit-detail": "Jedinica",
    "crm-unit-price-detail": "Jedinična cena",
    "crm-discount-pct": "Popust %",
    "crm-tax-pct": "Porez %",
    "crm-margin-detail": "Marža",
    "crm-total-detail": "Ukupno",
    "crm-total-margin": "Ukupna marža",
    "crm-subtotal": "Međuzbir",
    "crm-discount": "Popust",
    "crm-tax": "Porez",
    "crm-terms": "Uslovi",
    "crm-version-history": "Istorija verzija",
    "crm-no-versions-saved": "Još nema sačuvanih verzija",
    "crm-version": "Verzija",
    "crm-change-note": "Napomena o izmeni",
    "crm-author": "Autor",
    "crm-auto-saved-revisions": "Automatski sačuvane revizije",
    "crm-no-auto-saved-revisions": "Još nema automatski sačuvanih revizija",
    "crm-auto-saved-desc": "Svaka izmena ove ponude se automatski čuva kao verzija sa diff-om po poljima.",
    "crm-changes": "Izmene",
    "crm-save-new-version-desc": "Sačuvajte snapshot ove ponude kao novu verziju. Prethodne verzije biće označene kao zamenjene.",
    "crm-change-note-required": "Molimo unesite napomenu o izmeni.",
    "crm-change-note-placeholder": "Opišite šta je izmenjeno u ovoj verziji…",
    "crm-offer-summary": "Sažetak ponude",
    "crm-version-saved": "Verzija sačuvana!",
    "crm-version-saved-desc": "Verzija ${n} uspešno sačuvana.",
    "crm-failed-save-version": "Čuvanje verzije nije uspelo.",
    "crm-only-draft-can-be-sent": "Samo ponude u nacrtu mogu biti poslate",
    "crm-send-offer-tooltip": "Pošalji ovu ponudu na portal partnera (i email ako je konfigurisan)",
    "crm-save-version-tooltip": "Sačuvaj novu verziju ove ponude sa napomenom o izmeni",
    "crm-must-be-accepted-or-sent": "Ponuda mora biti prihvaćena ili poslata da bi se kreirala faktura",
    "crm-auto-create-invoice-tooltip": "Automatski kreiraj fakturu iz ove ponude",
    "crm-auto-create-proforma-tooltip": "Automatski kreiraj predračun iz ove ponude",
    "crm-offer-sent-to-portal": "Ponuda poslata na portal",
    "crm-failed-send-offer": "Slanje ponude nije uspelo.",
    "crm-offer-created-from-deal-success": "Ponuda uspešno kreirana iz posla!",
    "crm-invoice-created-from-offer": "Faktura kreirana iz ponude!",
    "crm-proforma-created-from-offer": "Predračun kreiran iz ponude!",
    "crm-status-updated": "Status ažuriran.",
    "crm-status-change-failed": "Promena statusa nije uspela.",
    "crm-bulk-send-failed": "Grupno slanje nije uspelo.",
    "crm-bulk-download-failed": "Grupno preuzimanje nije uspelo.",
    "crm-offer-updated-desc": "Referenca: ${number}",
    "crm-offer-created-toast": "Ponuda kreirana!",
    "crm-offer-created-toast-desc": "Vaša nova ponuda je sačuvana kao nacrt.",
    "crm-update-offer-details": "Ažurirajte detalje ponude ispod.",
    "crm-create-offer-desc": "Popunite osnovne podatke, dodajte stavke i to je to.",
    "crm-review-prefilled-offer": "Pregledaj unapred popunjenu ponudu",
    "crm-prefilled-from-trade-calc": "Unapred popunjeno iz trgovinskog kalkulatora",
    "crm-prefilled-success-desc": "Sva polja su automatski popunjena iz trgovinskog kalkulatora. Pregledajte podatke i sačuvajte kada ste spremni.",
    "crm-partner-section": "Partner",
    "crm-trade-terms-section": "Trgovinski uslovi",
    "crm-trade-terms-desc": "Incoterm · POL · POD · Plaćanje · Valjanost · Rok isporuke",
    "crm-incoterm-required": "Incoterm *",
    "crm-select-incoterm": "Izaberite incoterm",
    "crm-payment-terms-required": "Uslovi plaćanja *",
    "crm-select-payment-terms": "Izaberite uslove plaćanja",
    "crm-valid-until-required": "Važi do *",
    "crm-loading-port-pol": "Luka utovara (POL)",
    "crm-discharge-port-pod": "Luka istovara (POD)",
    "crm-lead-time-label": "Rok isporuke",
    "crm-packaging-label": "Pakovanje",
    "crm-origin-country-label": "Zemlja porekla",
    "crm-select-origin-country": "Izaberite zemlju porekla",
    "crm-inspection-label": "Inspekcija",
    "crm-select-inspection": "Izaberite inspekciju",
    "crm-certificate-label": "Sertifikat",
    "crm-auto-fill-catalog-supplier": "Automatski popuni iz kataloga i ponuda dobavljača",
    "crm-no-line-items": "Još nema stavki",
    "crm-click-add-item": "Kliknite \\\"Dodaj stavku\\\" da dodate proizvode ili usluge",
    "crm-disc-pct": "Pop.%",
    "crm-tax-pct-form": "Porez%",
    "crm-line-total": "Zbir stavke",
    "crm-product-name-override": "Naziv proizvoda (override)",
    "crm-bank-account-payment": "Bankovni račun za plaćanje",
    "crm-no-bank-accounts": "Nijedan bankovni račun nije konfigurisan za ovog tenanta. Dodajte ih u podešavanjima tenanta da omogućite brzi izbor bankovnog računa.",
    "crm-bank-account": "Bankovni račun",
    "crm-select-bank-account": "Izaberite bankovni račun (ili koristite prilagođeni tekst ispod)…",
    "crm-bank-details-editable": "Bankovni podaci (izmenjivo — prikazano doslovno na PDF-u ponude)",
    "crm-bank-details-placeholder": "Naziv banke, broj računa, IBAN, SWIFT/BIC…",
    "crm-customized-note": "Prilagođeno — izmene ovde ne utiču na sačuvani bankovni račun tenanta.",
    "crm-bank-details-auto-filled": "Bankovni podaci automatski popunjeni",
    "crm-offer-text": "Tekst ponude",
    "crm-template-builder": "Kreator šablona + slobodne napomene",
    "crm-notes-placeholder": "Dodatne napomene vidljive partneru…",
    "crm-offer-text-terms": "Tekst ponude / Uslovi i odredbe",
    "crm-totals": "Zbirovi",
    "crm-totals-auto-calc": "Automatski izračunato iz stavki",
    "crm-amount-in-words": "Iznos rečima",
    "crm-auto-calculated": "Automatski izračunato",
    "crm-grand-total": "Ukupno",
    "crm-data-completeness": "Potpunost podataka",
    "crm-critical": "kritično",
    "crm-to-review": "za pregled",
    "crm-all-complete": "Sve popunjeno",
    "crm-subject-deal-etc": "Subjekt, posao, brod, kontejner, klauzula o porezu…",
    "crm-subject-label": "Subjekt",
    "crm-linked-deal": "Povezani posao",
    "crm-no-deal": "Bez posla",
    "crm-supplier-ref-label": "Referenca dobavljača (offer_no)",
    "crm-selling-price-label": "Prodajna cena",
    "crm-tax-clause-label": "Klauzula o porezu",
    "crm-vessel-label": "Brod",
    "crm-container-no-label": "Kontejner br.",
    "crm-per-unit": "Po jedinici",
    "crm-create-offer": "Kreiraj ponudu",
    "crm-status-label": "Status",
    "crm-total-label": "Ukupno",
    "crm-items-label": "Stavke",
    "crm-date": "Datum",
    "crm-filename": "Naziv fajla *",
    "crm-filename-required": "Naziv fajla je obavezan.",
    "crm-category-label": "Kategorija",
    "crm-upload-document": "Otpremi dokument",
    "crm-upload-document-desc": "Registrujte dokument za ovog partnera.",
    "crm-delete-document-title": "Obrisati dokument?",
    "crm-delete-document-desc": "Ova radnja se ne može poništiti.",
    "crm-deleting": "Brisanje…",
    "crm-document-deleted": "Dokument obrisan.",
    "crm-document-registered": "Dokument registrovan.",
    "crm-upload-failed": "Otpremanje nije uspelo",
    "crm-save-failed": "Čuvanje nije uspelo",
    "crm-this-field-not-filled": "Ovo polje nije popunjeno iz trgovinskog kalkulatora",
    "crm-partner-name-ph": "Acme Trading Ltd.",
    "crm-email-ph": "contact@company.com",
    "crm-tax-id-ph": "npr. PIB",
    "crm-vat-number-ph": "npr. EU PDV broj",
    "crm-registration-no-ph": "Matični broj preduzeća",
    "crm-bank-name-ph": "npr. Deutsche Bank",
    "crm-account-ph": "IBAN ili broj računa",
    "crm-iban-ph": "npr. DE89 3704 0044 0532 0130 00",
    "crm-swift-ph": "npr. DEUTDEFF",
    "crm-partner-notes-ph": "Dodatne napomene o ovom partneru…",
    "crm-contact-name-ph": "John Doe",
    "crm-contact-email-ph": "john@company.com",
    "crm-portal-email-ph": "partner@company.com",
}


def main():
    src = FILE.read_text()

    pat = re.compile(r'^  ([a-z]{2}):\s*\{', re.MULTILINE)
    matches = list(pat.finditer(src))
    sections = {}
    for m in matches:
        locale = m.group(1)
        start = m.end()
        end_m = re.search(r'\n  },', src[start:])
        end = start + end_m.start() if end_m else len(src)
        sections[locale] = (start, end)

    en_start, en_end = sections['en']
    sr_start, sr_end = sections['sr']
    en_text = src[en_start:en_end]
    sr_text = src[sr_start:sr_end]

    def find_subsection_bounds(text):
        lines = text.split('\n')
        start_idx = None
        end_idx = None
        for i, line in enumerate(lines):
            if '─── Partners, Deals, Offers' in line:
                start_idx = i
            if '── partner-picker ──' in line:
                end_idx = i
                break
        return start_idx, end_idx, lines

    en_si, en_ei, en_lines = find_subsection_bounds(en_text)
    sr_si, sr_ei, sr_lines = find_subsection_bounds(sr_text)

    # Extract existing SR key->raw_value_string (preserving original quoting)
    sr_existing = {}
    sr_kv_pat = re.compile(r'"([a-z0-9-]+)":\s*(["\'])')
    for m in sr_kv_pat.finditer(sr_text):
        key = m.group(1)
        quote = m.group(2)
        val_start = m.end()
        j = val_start
        n = len(sr_text)
        while j < n:
            if sr_text[j] == '\\':
                j += 2
                continue
            if sr_text[j] == quote:
                break
            j += 1
        raw_inner = sr_text[val_start:j]
        sr_existing[key] = (quote, raw_inner)

    print(f"Existing SR keys: {len(sr_existing)}")

    new_sr_lines = []
    en_kv_pat = re.compile(r'^(\s*)"([a-z0-9-]+)":\s*(["\'])')
    used_translations = set()
    reused_existing = 0
    added_new = 0
    warnings = []

    for i in range(en_si, en_ei):
        line = en_lines[i]
        m = en_kv_pat.match(line)
        if not m:
            new_sr_lines.append(line)
            continue

        indent = m.group(1)
        key = m.group(2)
        en_quote = m.group(3)

        if key in sr_existing:
            quote, raw_inner = sr_existing[key]
            new_sr_lines.append(f'{indent}"{key}": {quote}{raw_inner}{quote},')
            reused_existing += 1
        elif key in TRANSLATIONS:
            value = TRANSLATIONS[key]
            new_sr_lines.append(f'{indent}"{key}": "{value}",')
            used_translations.add(key)
            added_new += 1
        else:
            val_start = m.end()
            j = val_start
            while j < len(line):
                if line[j] == '\\':
                    j += 2
                    continue
                if line[j] == en_quote:
                    break
                j += 1
            raw_inner = line[val_start:j]
            new_sr_lines.append(f'{indent}"{key}": {en_quote}{raw_inner}{en_quote},  // FALLBACK EN')
            warnings.append(key)

    print(f"Reused existing SR translations: {reused_existing}")
    print(f"Added new translations: {added_new}")
    print(f"Translations dict size: {len(TRANSLATIONS)}")
    unused = set(TRANSLATIONS) - used_translations
    print(f"Translations unused ({len(unused)}): {sorted(unused)}")
    if warnings:
        print(f"WARNINGS — no translation, used EN fallback: {warnings}")

    new_sr_sub = '\n'.join(new_sr_lines)

    sr_prefix_lines = sr_lines[:sr_si]
    sr_suffix_lines = sr_lines[sr_ei:]
    new_sr_text = '\n'.join(sr_prefix_lines) + '\n' + new_sr_sub + '\n' + '\n'.join(sr_suffix_lines)

    new_src = src[:sr_start] + new_sr_text + src[sr_end:]

    FILE.write_text(new_src)
    print(f"\nFile written: {FILE}")
    print(f"  Old size: {len(src)} chars")
    print(f"  New size: {len(new_src)} chars")


if __name__ == '__main__':
    main()
