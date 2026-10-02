import { useState } from "react";
import { FileSpreadsheet, FileText, Printer } from "lucide-react";
import { downloadExcelReport, downloadHtmlReport, openPdfReport } from "../lib/report-export";
import { Button } from "./Ui.jsx";

export default function ReportDownloads({ getReport, fileName, onError }) {
  const [busy, setBusy] = useState("");

  async function run(format) {
    let printWindow = null;
    if (format === "pdf") {
      printWindow = window.open("", "_blank");
      if (!printWindow) {
        onError?.("Allow pop-ups for this site, then try the PDF report again.");
        return;
      }
      printWindow.document.write("<p style='font:14px Arial;padding:24px'>Preparing your CSAT report…</p>");
    }
    setBusy(format);
    try {
      const report = await getReport();
      if (format === "pdf") openPdfReport(report, printWindow);
      if (format === "html") downloadHtmlReport(report, fileName);
      if (format === "excel") await downloadExcelReport(report, fileName);
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      onError?.(error.message || "Could not prepare the report.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="report-downloads" aria-label="Download CSAT report">
      <span>Download report</span>
      <Button icon={Printer} onClick={() => run("pdf")} disabled={Boolean(busy)}>
        {busy === "pdf" ? "Preparing…" : "PDF"}
      </Button>
      <Button icon={FileText} onClick={() => run("html")} disabled={Boolean(busy)}>
        {busy === "html" ? "Preparing…" : "HTML"}
      </Button>
      <Button icon={FileSpreadsheet} onClick={() => run("excel")} disabled={Boolean(busy)}>
        {busy === "excel" ? "Preparing…" : "Excel"}
      </Button>
    </div>
  );
}
