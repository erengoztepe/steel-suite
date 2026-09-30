/**
 * AnalysisResults — displays analysis outcomes with pass/fail banner,
 * per-component unity check bars, and the parameter summary.
 */

import type { AnalysisResult, ConnectionDefaults } from './types';

interface AnalysisResultsProps {
  result: AnalysisResult;
  params: ConnectionDefaults;
  templateName: string;
  onNewAnalysis: () => void;
  onShowIn3D?: () => void;
  isLoading3D?: boolean;
  onDownloadIfc?: () => void;
  isDownloadingIfc?: boolean;
  onOptimize?: () => void;
}

/** Readable labels for ConnectionDefaults keys. */
const PARAM_LABELS: Record<string, string> = {
  plateThicknessMm: 'Plaka Kalınlığı (mm)',
  boltDiameter: 'Cıvata Çapı',
  boltGrade: 'Cıvata Sınıfı',
  boltCount: 'Cıvata Sayısı',
  boltRows: 'Satır',
  boltCols: 'Sütun',
  weldThicknessMm: 'Kaynak (mm)',
  weldType: 'Kaynak Tipi',
};

export function AnalysisResults({
  result,
  params,
  templateName,
  onNewAnalysis,
  onShowIn3D,
  isLoading3D,
  onDownloadIfc,
  isDownloadingIfc,
  onOptimize,
}: AnalysisResultsProps) {
  const isPass = result.maxUnityCheck <= 1.0;

  const barColor = (v: number) =>
    v <= 0.8 ? 'bg-status-success' : v <= 1.0 ? 'bg-status-warning' : 'bg-status-error';
  const textColor = (v: number) =>
    v <= 0.8 ? 'text-status-success' : v <= 1.0 ? 'text-status-warning' : 'text-status-error';
  const statusIcon = (v: number) =>
    v <= 0.8 ? '✅' : v <= 1.0 ? '⚠️' : '❌';

  return (
    <div className="flex flex-col gap-4 p-4 animate-[ve-fade-in_0.3s_ease-out]">
      {/* ── Overall status banner ── */}
      <div
        className={`p-4 rounded-xl flex items-center gap-3 border ${
          isPass
            ? 'bg-status-success/10 border-status-success'
            : 'bg-status-error/10 border-status-error'
        }`}
      >
        <span className="text-3xl">{isPass ? '✅' : '❌'}</span>
        <div className="flex flex-col">
          <span
            className={`text-lg font-bold ${
              isPass ? 'text-status-success' : 'text-status-error'
            }`}
          >
            {isPass ? 'GEÇER (Pass)' : 'BAŞARISIZ (Fail)'}
          </span>
          <span className="text-xs text-text-secondary">
            Maksimum Kullanım:{' '}
            <strong className={textColor(result.maxUnityCheck)}>
              {(result.maxUnityCheck * 100).toFixed(1)}%
            </strong>
          </span>
        </div>
      </div>

      {/* ── Per-component checks ── */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-text-primary border-b border-border-primary/50 pb-1">
          Bileşen Kontrolleri
        </h4>
        <div className="flex flex-col gap-2">
          {result.checks.map((check, idx) => (
            <div
              key={idx}
              className="flex flex-col gap-1 bg-bg-secondary p-2 rounded-lg border border-border-primary/30"
            >
              <div className="flex justify-between items-center text-xs">
                <span className="text-text-primary font-medium">{check.name}</span>
                <span className="flex items-center gap-1.5">
                  <span className={textColor(check.unityCheck)}>
                    {(check.unityCheck * 100).toFixed(1)}%
                  </span>
                  <span className="text-xs">{statusIcon(check.unityCheck)}</span>
                </span>
              </div>
              <div className="w-full bg-bg-primary h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full ${barColor(check.unityCheck)} transition-all duration-500`}
                  style={{ width: `${Math.min(check.unityCheck * 100, 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Parameters summary ── */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-text-primary border-b border-border-primary/50 pb-1">
          Parametreler — {templateName}
        </h4>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-text-secondary bg-bg-secondary p-3 rounded-lg">
          {Object.entries(params).map(([key, val]) => (
            <div key={key} className="flex justify-between">
              <span className="opacity-70">{PARAM_LABELS[key] ?? key}</span>
              <span className="text-text-primary font-medium">{String(val)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Action buttons ── */}
      <div className="flex gap-2 mt-2">
        {onShowIn3D && (
          <button
            type="button"
            onClick={onShowIn3D}
            disabled={isLoading3D}
            className="flex-1 px-4 py-2 rounded-xl text-sm font-medium text-brand-secondary bg-brand-secondary/10 hover:bg-brand-secondary hover:text-white transition-colors border border-brand-secondary/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading3D ? 'Yükleniyor...' : 'Bağlantı 3D Model'}
          </button>
        )}
        {onDownloadIfc && (
          <button
            type="button"
            onClick={onDownloadIfc}
            disabled={isDownloadingIfc}
            title="Bağlantı IFC'sini İndir"
            className="px-4 py-2 rounded-xl text-sm font-medium text-brand-secondary bg-brand-secondary/10 hover:bg-brand-secondary hover:text-white transition-colors border border-brand-secondary/30 flex items-center justify-center disabled:opacity-50"
          >
            {isDownloadingIfc ? '...' : '↓'}
          </button>
        )}
      </div>
      {onOptimize && (
        <button
          type="button"
          onClick={onOptimize}
          className="w-full mt-2 px-4 py-2 rounded-xl text-sm font-medium text-emerald-600 bg-emerald-500/10 hover:bg-emerald-600 hover:text-white transition-colors border border-emerald-500/30"
        >
          Otomatik Optimizasyon (Maliyet Düşür)
        </button>
      )}
      <button
        type="button"
        onClick={onNewAnalysis}
        className="w-full mt-2 px-4 py-2 rounded-xl text-sm font-medium text-text-primary bg-transparent border border-border-primary hover:bg-bg-secondary transition-colors"
      >
        Yeni Analiz Başlat
      </button>
    </div>
  );
}
