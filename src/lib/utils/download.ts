"use client";

/**
 * downloadPdf — fetches a PDF from `url` (with same-origin credentials so the
 * session cookie is sent) and triggers a browser "Save As" download with the
 * given filename.
 *
 * Why this exists:
 *   The previous pattern was `<a href="/api/.../pdf" download>` which has two
 *   problems:
 *     1. `download` + `target="_blank"` together cause inconsistent behavior
 *        across browsers (some open a new tab, some download).
 *     2. If the endpoint returns an error (e.g. JSON `{ "error": "No tenant." }`
 *        because a super-admin didn't pass `?tenant_id=`), the browser happily
 *        saves that JSON blob as a file named `pdf.json` — which the user then
 *        can't open. This is the "pise pdf.json i fail download" bug.
 *
 *   Using `fetch()` + `Blob` lets us:
 *     - check the HTTP status and content-type before saving
 *     - surface a real error toast to the user instead of a junk .json file
 *     - control the filename precisely
 *
 * @param url         API URL (relative or absolute) returning a PDF
 * @param filename    Desired download filename (defaults to "document.pdf")
 * @throws            Error with a human-readable message if the response is
 *                    not a valid PDF or the request fails.
 */
export async function downloadPdf(url: string, filename: string = "document.pdf"): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch (e: any) {
    throw new Error(e?.message || "Network error while downloading PDF.");
  }

  if (!res.ok) {
    // Try to extract a JSON error message from the server
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const err = await res.json().catch(() => ({} as any));
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    // Non-JSON error (e.g. 500 HTML page) — read a short snippet
    let snippet = "";
    try {
      snippet = (await res.text()).slice(0, 120);
    } catch { /* ignore */ }
    throw new Error(snippet || `HTTP ${res.status}`);
  }

  // Read the body as a blob
  const blob = await res.blob();

  // Verify it's actually a PDF. The server should set Content-Type: application/pdf
  // but be defensive — also accept missing content-type and check the magic bytes.
  const ct = blob.type || "";
  const isPdfByType = ct === "application/pdf" || ct.includes("pdf");
  let isPdfByMagic = false;
  if (!isPdfByType && blob.size >= 4) {
    try {
      const buf = await blob.slice(0, 4).arrayBuffer();
      const bytes = new Uint8Array(buf);
      // %PDF = 0x25 0x50 0x44 0x46
      isPdfByMagic = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    } catch { /* ignore — let the click through and rely on content-type */ }
  }
  if (!isPdfByType && !isPdfByMagic) {
    // Likely the server returned JSON or HTML — read a snippet for the toast
    let snippet = "";
    try {
      snippet = (await blob.text()).slice(0, 160);
    } catch { /* ignore */ }
    throw new Error(snippet ? `Server did not return a PDF: ${snippet}` : "Server did not return a PDF.");
  }

  // Build an object URL and trigger a click on a synthetic <a> element.
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.rel = "noopener";
  // Some browsers require the element to be in the DOM to honor `download`
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke shortly after the click so the browser has time to start the download
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}
