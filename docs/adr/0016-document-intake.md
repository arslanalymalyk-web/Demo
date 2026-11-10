# ADR 0016: Document intake and OCR

Status: accepted.

- A document is stored unchanged, with its SHA-256, in the database. The same file uploaded twice returns the existing record.
- The file type is decided from its content. Executables, scripts, archives other than Word documents, and archives that inflate far beyond their size are refused. Limits: 20 MB and 100 pages.
- Text comes from deterministic tools only: the PDF text layer (poppler), OCR for scanned pages and images (Tesseract, English and Arabic), Word text, and plain text. A PDF page with no usable text layer is rendered and recognised, so one file can mix methods. No model reads, summarises or rewrites content.
- External tools run on untrusted files with no shell, a clean environment, a private temporary directory and a time limit.
- Each page records how it was obtained and, for OCR, the engine's own confidence. The result becomes ordinary evidence: provenance, validation (no text fails, low OCR confidence warns or fails), case attachment and the policy gate all apply unchanged.
- The uploader must state the rights and, for a public record, the publishing agency. These are recorded as declared and not verified, so the evidence is "warned" until a person confirms the licence.
- Institution documents stay off until an operator sets `TIGERIS_CLIENT_DATA_ENABLED=true`, which should follow the NDA and a data processing agreement. Public records and sample datasets are always labelled as such.
- Processing is queued in-process and resumes after a restart. Original files, pages and the document's declared origin cannot be changed or deleted. Every upload, processing result, retry and download is audited.
- Known gaps: no malware scanning (an institutional scanner must be placed in front), no redaction, no table or figure extraction, and no per-document access restriction beyond the evidence role.
