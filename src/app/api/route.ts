/**
 * API Root — VELOS Trade API
 * Returns API version and available endpoints.
 */
import { NextResponse } from "next/server";

export async function GET() {
  try {
    return NextResponse.json({
      name: "VELOS Trade API",
      version: "1.0.0",
      description: "Trade management platform API",
      endpoints: {
        deals: "/api/deals",
        partners: "/api/partners",
        products: "/api/products",
        offers: "/api/offers",
        invoices: "/api/invoices",
        documents: "/api/documents",
        customs: "/api/customs",
        logistics: "/api/logistics",
        marketNews: "/api/market-news",
        emailTemplates: "/api/email-templates",
        erp: "/api/erp",
        settings: "/api/settings",
        health: "/api/health",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
