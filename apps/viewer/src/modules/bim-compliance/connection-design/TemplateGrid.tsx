/**
 * TemplateGrid — visual grid of connection templates.
 *
 * Renders each template as a card with an icon, Turkish name, behavior badge,
 * and — for recommended templates — a glowing border + hover tooltip explaining
 * the recommendation.
 */

import { useState } from 'react';
import type { ConnectionTemplate } from './types';

interface TemplateGridProps {
  templates: ConnectionTemplate[];
  onSelect: (template: ConnectionTemplate) => void;
}

const BEHAVIOR_ICONS: Record<string, string> = {
  shear: '🔩',
  moment: '⚙️',
  axial: '📐',
};

const BEHAVIOR_LABELS: Record<string, string> = {
  shear: 'Kesme',
  moment: 'Moment',
  axial: 'Eksenel',
};

export function TemplateGrid({ templates, onSelect }: TemplateGridProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-2 gap-3 p-4 animate-[ve-fade-in_0.3s_ease-out]">
      {templates.map((template) => (
        <div
          key={template.id}
          className={`
            relative flex flex-col items-center p-4 rounded-xl cursor-pointer
            transition-all duration-200 bg-bg-secondary border text-center
            hover:scale-[1.02] hover:bg-bg-quaternary
            ${template.isRecommended
              ? 'border-brand-primary shadow-[0_0_8px_rgba(175,216,212,0.3)]'
              : 'border-border-primary/40'}
          `}
          onMouseEnter={() => setHoveredId(template.id)}
          onMouseLeave={() => setHoveredId(null)}
          onClick={() => onSelect(template)}
        >
          {/* Recommended badge */}
          {template.isRecommended && (
            <div className="absolute -top-2 -right-2 bg-bg-primary border border-brand-primary rounded-full w-6 h-6 flex items-center justify-center text-xs shadow-md">
              ⭐
            </div>
          )}

          {/* Icon */}
          <div className="w-full h-16 mb-2 flex items-center justify-center text-3xl" aria-hidden="true">
            {BEHAVIOR_ICONS[template.behavior] ?? '🔗'}
          </div>

          {/* Name */}
          <h3 className="text-xs font-medium text-text-primary mb-2 leading-tight">
            {template.nameLocal}
          </h3>

          {/* Behavior badge */}
          <span className="text-[10px] px-2 py-0.5 bg-bg-primary rounded-full text-brand-primary border border-border-primary/50">
            {BEHAVIOR_LABELS[template.behavior] ?? template.behavior}
          </span>

          {/* Hover tooltip with recommendation reason */}
          {hoveredId === template.id && template.isRecommended && template.recommendationReasonLocal && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-20 w-48 p-2 text-[11px] bg-bg-primary border border-brand-primary rounded-lg shadow-lg text-text-primary animate-[ve-fade-in_0.15s_ease-out]">
              {template.recommendationReasonLocal}
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 border-x-4 border-x-transparent border-b-4 border-b-brand-primary" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
