/**
 * AutoFixPanel — recommendation engine UI.
 *
 * Shown beneath AnalysisResults when the analysis fails. Each recommendation
 * card shows the current vs recommended value and a one-click "Apply & Re-solve"
 * button. A loading overlay appears while re-analysis runs.
 */

import type { AutoFixRecommendation } from './types';

interface AutoFixPanelProps {
  recommendations: AutoFixRecommendation[];
  onApplyFix: (rec: AutoFixRecommendation) => void;
  onApplyAll: () => void;
  isAnalyzing: boolean;
}

export function AutoFixPanel({
  recommendations,
  onApplyFix,
  onApplyAll,
  isAnalyzing,
}: AutoFixPanelProps) {
  if (recommendations.length === 0) return null;

  return (
    <div className="relative flex flex-col gap-3 p-4 bg-bg-secondary border-2 border-brand-secondary rounded-xl animate-[ve-fade-in_0.3s_ease-out] shadow-[0_0_15px_rgba(248,130,101,0.15)] mt-4">
      {/* Loading overlay */}
      {isAnalyzing && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-bg-primary/80 backdrop-blur-sm rounded-xl">
          <div className="w-8 h-8 border-3 border-brand-secondary border-t-transparent rounded-full animate-spin" />
          <span className="mt-2 text-sm text-brand-secondary font-medium animate-pulse">
            Yeniden Çözülüyor...
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 border-b border-brand-secondary/30 pb-2">
        <span className="text-xl">🔧</span>
        <h3 className="text-brand-secondary font-bold text-sm">Akıllı Asistan Önerisi</h3>
      </div>

      {/* Recommendation cards */}
      <div className="flex flex-col gap-3">
        {recommendations.map((rec, idx) => (
          <div
            key={idx}
            className="flex flex-col gap-2 p-3 bg-bg-primary rounded-lg border border-border-primary/40"
          >
            <p className="text-xs text-text-primary">{rec.descriptionLocal}</p>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className="text-status-error line-through opacity-70 px-2 py-0.5 bg-status-error/10 rounded">
                  {String(rec.currentValue)}
                </span>
                <span className="text-text-secondary">→</span>
                <span className="text-status-success px-2 py-0.5 bg-status-success/10 rounded">
                  {String(rec.recommendedValue)}
                </span>
              </div>
              <button
                type="button"
                disabled={isAnalyzing}
                onClick={() => onApplyFix(rec)}
                className="px-2 py-1 text-[10px] font-medium rounded-lg border border-brand-secondary/30 bg-brand-secondary/10 text-brand-secondary hover:bg-brand-secondary hover:text-white transition-colors disabled:opacity-50"
              >
                Uygula
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Apply all button */}
      {recommendations.length > 1 && (
        <button
          type="button"
          disabled={isAnalyzing}
          onClick={onApplyAll}
          className="w-full mt-1 px-4 py-2 rounded-xl text-sm font-medium bg-brand-secondary text-white hover:bg-brand-secondary-hover transition-colors disabled:opacity-50"
        >
          Tümünü Uygula ve Yeniden Çöz
        </button>
      )}
    </div>
  );
}
