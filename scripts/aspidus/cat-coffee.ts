// Aspidus DMCC — Coffee Product Catalog (20 products)
// Sub-categories: ARB (Arabica) 12, ROB (Robusta) 6, SPC (Specialty) 2

export interface CoaParam { name: string; value: string; }
export interface Logistics { cap20: number | null; cap40: number | null; }
export interface SeedProduct {
  sku: string; name: string; category: string; unit: string;
  price: number; currency: string; cost: number;
  stock: number; reorder_level: number; active: boolean;
  description: string; hs_code: string;
  brand: null; shelf_life: string | null; image_url: null;
  logistics: Logistics; coa_params: CoaParam[];
  detailed_spec: string; tags: string[];
}

function p(o: {
  sku: string; name: string; category: string;
  hs: string; price: number; unit?: string;
  coa: [string, string][]; spec: string;
  cap20?: number | null; cap40?: number | null;
  tags?: string[]; shelfLife?: string | null;
  desc?: string; stock?: number;
}): SeedProduct {
  const unit = o.unit ?? "MT";
  const stock = o.stock ?? 50000;
  return {
    sku: o.sku, name: o.name, category: o.category, unit,
    price: o.price, currency: "USD", cost: o.price, stock,
    reorder_level: Math.max(1, Math.floor(stock / 20)),
    active: true, description: o.desc ?? o.name,
    hs_code: o.hs, brand: null,
    shelf_life: o.shelfLife ?? null, image_url: null,
    logistics: { cap20: o.cap20 ?? null, cap40: o.cap40 ?? null },
    coa_params: o.coa.map(([name, value]) => ({ name, value })),
    detailed_spec: o.spec, tags: o.tags ?? [],
  };
}

// Coffee logistics preset: 60kg jute bags
const JUTE60 = { cap20: 18000, cap40: 27000 };
const SHELF = "24 months from harvest under proper storage";

export const coffeeProducts: SeedProduct[] = [
  // ============ ARB — ARABICA (12) ============
  p({
    sku: "COF-ARB-01-001", name: "Brazil Santos 2/3 SS17", category: "coffee",
    hs: "0901210000", price: 3800, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "brazil", "santos", "natural"],
    coa: [
      ["Screen Size", "17/18 SS"], ["Defects", "Type 2/3"],
      ["Moisture", "12.0% Max"], ["Density", "680-720 g/l"],
      ["Color", "Green-bluish"], ["Cup Profile", "Clean, sweet, nutty, chocolate"],
      ["Acidity", "Medium"], ["Body", "Medium-high"],
      ["Origin", "Brazil (Sao Paulo/Minas Gerais)"], ["Processing", "Natural (unwashed)"],
    ],
    spec: "ORIGIN: Brazil (Sao Paulo/Minas Gerais). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary, Certificate of Origin, SGS/SCA cupping, ICO export. QUALITY: SCA 80-83 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months from harvest. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-02-001", name: "Colombia Excelso EP", category: "coffee",
    hs: "0901210000", price: 4300, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "colombia", "excelso", "washed"],
    coa: [
      ["Screen Size", "15/16 SS (Excelso)"], ["Defects", "Max 8 per 300g"],
      ["Moisture", "12.0% Max"], ["Density", "680-720 g/l"],
      ["Color", "Green-emerald"], ["Cup Profile", "Bright acidity, caramel, citrus"],
      ["Acidity", "High, bright"], ["Body", "Medium"],
      ["Origin", "Colombia"], ["Processing", "Washed (EP - European Prep)"],
    ],
    spec: "ORIGIN: Colombia (Huila/Antioquia/Caldas). PACKAGING: 70kg jute bags with GrainPro liner; 60kg standard. CERTIFICATIONS: Phytosanitary, FNC Certificate of Origin, SGS cupping, ICO export. QUALITY: SCA 82-84 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-03-001", name: "Ethiopia Yirgacheffe G2", category: "coffee",
    hs: "0901210000", price: 4600, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "ethiopia", "yirgacheffe", "specialty"],
    coa: [
      ["Screen Size", "14/15 SS"], ["Grade", "Grade 2 (G2)"],
      ["Defects", "Max 8 per 300g"], ["Moisture", "11.5% Max"],
      ["Density", "670-700 g/l"], ["Color", "Green-yellow"],
      ["Cup Profile", "Floral, jasmine, lemon, tea-like"], ["Acidity", "Bright, winey"],
      ["Body", "Light-medium"], ["Origin", "Ethiopia (Yirgacheffe, Gedeo)"],
      ["Processing", "Washed"],
    ],
    spec: "ORIGIN: Ethiopia (Yirgacheffe, Gedeo Zone). PACKAGING: 60kg jute bags with GrainPro liner; 30kg specialty packs. CERTIFICATIONS: Phytosanitary, ECX Origin, SGS cupping, Fairtrade/Organic optional. QUALITY: SCA 84-87 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-04-001", name: "Guatemala SHB EP", category: "coffee",
    hs: "0901210000", price: 4400, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "guatemala", "shb", "washed"],
    coa: [
      ["Grade", "SHB (Strictly Hard Bean)"], ["Screen Size", "16/18 SS"],
      ["Defects", "Max 8 per 300g (EP)"], ["Moisture", "12.0% Max"],
      ["Density", "700-740 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Bright acidity, chocolate, spice"], ["Acidity", "Bright, lively"],
      ["Body", "Medium-full"], ["Origin", "Guatemala (Antigua/Huehuetenango)"],
      ["Processing", "Washed (EP - European Prep)"], ["Altitude", "1300-1700 m"],
    ],
    spec: "ORIGIN: Guatemala (Antigua/Huehuetenango). PACKAGING: 69kg jute bags with GrainPro liner; 60kg standard. CERTIFICATIONS: Phytosanitary, Anacafe Origin, SGS cupping, ICO export. QUALITY: SCA 83-86 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-05-001", name: "Honduras HG EP", category: "coffee",
    hs: "0901210000", price: 3700, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "honduras", "hg", "washed"],
    coa: [
      ["Grade", "HG (High Grown)"], ["Screen Size", "16/18 SS"],
      ["Defects", "Max 8 per 300g (EP)"], ["Moisture", "12.0% Max"],
      ["Density", "690-720 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Mild, sweet, caramel, citrus"], ["Acidity", "Medium, soft"],
      ["Body", "Medium"], ["Origin", "Honduras (Copan/Lempira/Marcala)"],
      ["Processing", "Washed (EP)"], ["Altitude", "1000-1500 m"],
    ],
    spec: "ORIGIN: Honduras (Copan, Lempira, Marcala). PACKAGING: 69kg jute bags with GrainPro liner; 60kg standard. CERTIFICATIONS: Phytosanitary Certificate, IHCAFE Certificate of Origin, SGS cupping report, ICO export. QUALITY: SCA 80-83 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from direct sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-06-001", name: "Costa Rica SHB EP", category: "coffee",
    hs: "0901210000", price: 4500, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "costa-rica", "shb", "washed"],
    coa: [
      ["Grade", "SHB (Strictly Hard Bean)"], ["Screen Size", "16/18 SS"],
      ["Defects", "Max 8 per 300g (EP)"], ["Moisture", "12.0% Max"],
      ["Density", "700-740 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Bright acidity, honey, citrus, clean"], ["Acidity", "Bright, vibrant"],
      ["Body", "Medium"], ["Origin", "Costa Rica (Tarrazu/West Valley)"],
      ["Processing", "Washed (EP)"], ["Altitude", "1200-1700 m"],
    ],
    spec: "ORIGIN: Costa Rica (Tarrazu/West Valley). PACKAGING: 69kg jute bags with GrainPro liner; 60kg standard. CERTIFICATIONS: Phytosanitary, ICAFE Origin, SGS cupping, ICO export. QUALITY: SCA 83-86 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-07-001", name: "Peru Organic FTO", category: "coffee",
    hs: "0901210000", price: 4200, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "peru", "organic", "fairtrade"],
    coa: [
      ["Grade", "Grade 1 Strictly Hard Bean"], ["Screen Size", "16/18 SS"],
      ["Defects", "Max 8 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "690-720 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Mild, sweet, nutty, chocolate"], ["Acidity", "Medium, soft"],
      ["Body", "Medium"], ["Certifications", "USDA Organic, EU Organic, Fairtrade"],
      ["Origin", "Peru (Chanchamayo/Northern)"], ["Processing", "Washed"],
    ],
    spec: "ORIGIN: Peru (Chanchamayo/Amazonas). PACKAGING: 69kg jute bags with GrainPro liner; organic-compliant bags. CERTIFICATIONS: Phytosanitary, USDA/EU Organic, Fairtrade, SGS cupping, ICO export. QUALITY: SCA 82-85 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-08-001", name: "Mexico Altura HG", category: "coffee",
    hs: "0901210000", price: 3900, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "mexico", "altura", "washed"],
    coa: [
      ["Grade", "Altura (HG - High Grown)"], ["Screen Size", "15/17 SS"],
      ["Defects", "Max 8 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "680-710 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Mild, sweet, nutty, light chocolate"], ["Acidity", "Medium, soft"],
      ["Body", "Light-medium"], ["Origin", "Mexico (Chiapas/Veracruz)"],
      ["Processing", "Washed"], ["Altitude", "900-1300 m"],
    ],
    spec: "ORIGIN: Mexico (Chiapas, Veracruz, Oaxaca). PACKAGING: 69kg jute bags with GrainPro liner; 60kg standard. CERTIFICATIONS: Phytosanitary Certificate, AMECAFE Certificate of Origin, SGS cupping report, ICO export. QUALITY: SCA 80-83 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from direct sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-09-001", name: "Kenya AA", category: "coffee",
    hs: "0901210000", price: 4800, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "kenya", "aa", "specialty"],
    coa: [
      ["Grade", "AA (screen 17/18+)"], ["Screen Size", "17/18 SS (AA)"],
      ["Defects", "Max 8 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "690-720 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Winey, blackcurrant, bright acidity"], ["Acidity", "High, winey"],
      ["Body", "Medium-full"], ["Origin", "Kenya (Central region/Nyeri)"],
      ["Processing", "Washed (double fermentation)"], ["Altitude", "1400-2000 m"],
    ],
    spec: "ORIGIN: Kenya (Nyeri/Kirinyaga/Kiambu). PACKAGING: 60kg jute bags with GrainPro liner; 50kg specialty packs. CERTIFICATIONS: Phytosanitary, NCEA Origin, SGS cupping, ICO export. QUALITY: SCA 85-88 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-10-001", name: "India Monsooned Malabar", category: "coffee",
    hs: "0901210000", price: 3600, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "india", "monsooned", "malabar"],
    coa: [
      ["Grade", "Monsooned Malabar AAA"], ["Screen Size", "17/18 SS"],
      ["Defects", "Max 10 per 300g"], ["Moisture", "13.0% Max"],
      ["Density", "600-640 g/l"], ["Color", "Pale yellow/straw"],
      ["Cup Profile", "Low acidity, heavy body, earthy, tobacco"], ["Acidity", "Very low"],
      ["Body", "Full, heavy"], ["Origin", "India (Malabar Coast, Karnataka)"],
      ["Processing", "Monsooned (wind-exposed)"], ["Bulk Density", "Low"],
    ],
    spec: "ORIGIN: India (Karnataka/Kerala - Malabar). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary, Coffee Board Origin, GI-protected, SGS cupping. QUALITY: SCA 78-82 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-11-001", name: "Uganda Bugisu AA", category: "coffee",
    hs: "0901210000", price: 4100, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "uganda", "bugisu", "washed"],
    coa: [
      ["Grade", "Bugisu AA"], ["Screen Size", "17/18 SS"],
      ["Defects", "Max 10 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "680-710 g/l"], ["Color", "Green-blue"],
      ["Cup Profile", "Winey, fruity, chocolate"], ["Acidity", "Medium-high, winey"],
      ["Body", "Medium-full"], ["Origin", "Uganda (Mt Elgon, Bugisu region)"],
      ["Processing", "Washed"], ["Altitude", "1300-2000 m"],
    ],
    spec: "ORIGIN: Uganda (Mbale/Sironko - Bugisu). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary, UCDA Origin, SGS cupping, ICO export. QUALITY: SCA 82-85 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ARB-12-001", name: "Indonesia Mandheling G1", category: "coffee",
    hs: "0901210000", price: 4000, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["arabica", "indonesia", "mandheling", "semi-washed"],
    coa: [
      ["Grade", "Grade 1 (G1)"], ["Screen Size", "17/18 SS"],
      ["Defects", "Max 11 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "650-690 g/l"], ["Color", "Blue-green"],
      ["Cup Profile", "Earthy, herbal, low acidity, syrupy body"], ["Acidity", "Low"],
      ["Body", "Full, syrupy"], ["Origin", "Indonesia (Sumatra, Mandheling)"],
      ["Processing", "Semi-washed (Giling Basah)"], ["Altitude", "900-1500 m"],
    ],
    spec: "ORIGIN: Indonesia (North Sumatra/Aceh - Mandheling). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary, Certificate of Origin, SGS cupping, ICO export. QUALITY: SCA 82-85 points. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),

  // ============ ROB — ROBUSTA (6) ============
  p({
    sku: "COF-ROB-01-001", name: "Vietnam G2 18 screen", category: "coffee",
    hs: "0901210000", price: 2100, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["robusta", "vietnam", "grade-2", "washed"],
    coa: [
      ["Grade", "Grade 2 (G2)"], ["Screen Size", "18 SS Min"],
      ["Defects", "Max 5%"], ["Moisture", "12.5% Max"],
      ["Density", "650-700 g/l"], ["Color", "Green-brown"],
      ["Cup Profile", "Strong, harsh, woody"], ["Caffeine", "2.2-2.7%"],
      ["Origin", "Vietnam (Central Highlands)"], ["Processing", "Washed"],
    ],
    spec: "ORIGIN: Vietnam (Central Highlands - Dak Lak/Lam Dong). PACKAGING: 60kg jute bags with inner liner; 1MT FIBCs; bulk in containers. CERTIFICATIONS: Phytosanitary, Certificate of Origin, SGS, ICO export. QUALITY: ICO Robusta standard. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ROB-02-001", name: "India Cherry AB", category: "coffee",
    hs: "0901210000", price: 2400, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["robusta", "india", "cherry", "natural"],
    coa: [
      ["Grade", "Cherry AB"], ["Screen Size", "16/17 SS (AB)"],
      ["Defects", "Max 8 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "650-700 g/l"], ["Color", "Green-brown"],
      ["Cup Profile", "Strong, spicy, woody"], ["Caffeine", "2.2-2.7%"],
      ["Origin", "India (Kerala/Karnataka)"], ["Processing", "Natural (unwashed)"],
    ],
    spec: "ORIGIN: India (Kerala/Karnataka/Tamil Nadu). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary, Coffee Board Origin, SGS, ICO export. QUALITY: India Robusta Cherry standard. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ROB-03-001", name: "Indonesia G1 18 screen", category: "coffee",
    hs: "0901210000", price: 2300, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["robusta", "indonesia", "grade-1", "natural"],
    coa: [
      ["Grade", "Grade 1 (G1)"], ["Screen Size", "18 SS Min"],
      ["Defects", "Max 3%"], ["Moisture", "12.0% Max"],
      ["Density", "650-700 g/l"], ["Color", "Green-brown"],
      ["Cup Profile", "Earthy, strong, tobacco"], ["Caffeine", "2.2-2.7%"],
      ["Origin", "Indonesia (Java/Sumatra)"], ["Processing", "Natural"],
    ],
    spec: "ORIGIN: Indonesia (Java, Sumatra, Sulawesi). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary Certificate, Certificate of Origin, SGS inspection, ICO export. QUALITY: Indonesia Robusta standard. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from direct sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ROB-04-001", name: "Uganda Screen 18", category: "coffee",
    hs: "0901210000", price: 2200, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["robusta", "uganda", "screen-18", "natural"],
    coa: [
      ["Grade", "Screen 18"], ["Screen Size", "18 SS Min"],
      ["Defects", "Max 10 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "650-700 g/l"], ["Color", "Green-grey"],
      ["Cup Profile", "Strong, neutral, nutty"], ["Caffeine", "2.2-2.7%"],
      ["Origin", "Uganda (Central/Eastern)"], ["Processing", "Natural (unwashed)"],
    ],
    spec: "ORIGIN: Uganda (Mukono, Luwero, Mbale). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary Certificate, UCDA Certificate of Origin, SGS inspection, ICO export. QUALITY: ICO Robusta standard. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from direct sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ROB-05-001", name: "Brazil Conilon", category: "coffee",
    hs: "0901210000", price: 2000, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["robusta", "brazil", "conilon", "natural"],
    coa: [
      ["Grade", "Conilon Grade 7/8"], ["Screen Size", "14/16 SS"],
      ["Defects", "Max 20 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "650-700 g/l"], ["Color", "Green-brown"],
      ["Cup Profile", "Strong, neutral, woody"], ["Caffeine", "2.2-2.7%"],
      ["Origin", "Brazil (Espirito Santo/Bahia)"], ["Processing", "Natural"],
    ],
    spec: "ORIGIN: Brazil (Espirito Santo, Bahia). PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary Certificate, Certificate of Origin, SGS inspection, ICO export. QUALITY: Brazil Conilon standard. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from direct sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-ROB-06-001", name: "Cote d'Ivoire Grade 2", category: "coffee",
    hs: "0901210000", price: 2050, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: SHELF,
    tags: ["robusta", "cote-divoire", "grade-2", "natural"],
    coa: [
      ["Grade", "Grade 2"], ["Screen Size", "15/16 SS"],
      ["Defects", "Max 10 per 300g"], ["Moisture", "12.0% Max"],
      ["Density", "650-700 g/l"], ["Color", "Green-brown"],
      ["Cup Profile", "Strong, neutral, woody"], ["Caffeine", "2.2-2.7%"],
      ["Origin", "Cote d'Ivoire"], ["Processing", "Natural (unwashed)"],
    ],
    spec: "ORIGIN: Cote d'Ivoire. PACKAGING: 60kg jute bags with GrainPro liner; bulk in containers. CERTIFICATIONS: Phytosanitary, BCC Origin, SGS, ICO export. QUALITY: ICO Robusta standard. HANDLING: Store cool (15-25°C), dry (RH 50-60%), ventilated; protect from sunlight, off-odors, moisture. Shelf life 24 months. Fumigation per ISPM-15.",
  }),

  // ============ SPC — SPECIALTY (2) ============
  p({
    sku: "COF-SPC-01-001", name: "Decaf Arabica MC Process", category: "coffee",
    hs: "0901220000", price: 4700, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: "18 months under proper storage",
    tags: ["arabica", "decaf", "methylene-chloride", "specialty"],
    coa: [
      ["Caffeine Content", "0.10% Max (97% removed)"], ["Screen Size", "17/18 SS"],
      ["Defects", "Max 8 per 300g"], ["Moisture", "11.5% Max"],
      ["Density", "680-720 g/l"], ["Color", "Green-brown"],
      ["Methylene Chloride Residual", "2 ppm Max (FDA)"], ["Cup Profile", "Clean, mild, balanced"],
      ["Acidity", "Medium"], ["Body", "Medium"],
      ["Origin", "Colombia/Brazil (decaffeinated EU/DE)"], ["Processing", "Decaf MC (methylene chloride)"],
    ],
    spec: "ORIGIN: Colombia/Brazil (decaf in EU-Germany). PACKAGING: 60kg jute bags with GrainPro liner; vacuum cartons; bulk. CERTIFICATIONS: Phytosanitary, EU Organic (optional), Kosher, Halal, SGS, ICO. QUALITY: FDA/EU decaf, SCA 80-83. HANDLING: Store cool (15-25°C), dry (RH 50-60%); protect from sunlight, off-odors, moisture. Shelf life 18 months. Fumigation per ISPM-15.",
  }),
  p({
    sku: "COF-SPC-02-001", name: "Instant Coffee 100% Spray Dried", category: "coffee",
    hs: "2101110000", price: 5000, cap20: JUTE60.cap20, cap40: JUTE60.cap40,
    shelfLife: "24 months from production",
    unit: "MT",
    tags: ["instant", "spray-dried", "soluble", "100-coffee"],
    coa: [
      ["Caffeine", "Min 2.5%"], ["Moisture", "5.0% Max"],
      ["Solubility (10% soln, 25°C)", "95% Min (10 sec)"], ["pH (1% soln)", "4.8-5.2"],
      ["Bulk Density", "220-260 g/l"], ["Particle Size", "1.0-2.0 mm"],
      ["Ash", "12.0% Max"], ["Caffeine Free", "N/A"],
      ["Origin", "Brazil/Vietnam/India"], ["Processing", "100% spray dried"],
      ["Color", "Light to medium brown"], ["Aroma", "Characteristic coffee"],
    ],
    spec: "ORIGIN: Brazil / Vietnam / India (100% soluble). PACKAGING: 25kg food-grade tin-tied bags with PE liner; 50kg fiber drums; private-label jars/sachets. CERTIFICATIONS: HACCP, BRC, ISO 22000, FSSC 22000, Kosher, Halal, FDA, SGS. QUALITY: 100% pure coffee extract, no fillers. HANDLING: Store cool (<25°C), dry (RH <60%); protect from moisture, off-odors. Shelf life 24 months from production.",
  }),
];
