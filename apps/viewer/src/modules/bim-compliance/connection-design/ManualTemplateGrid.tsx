import { useState, useEffect } from 'react';
import { getTemplatePictureUrl } from './api-client';

interface ConDesignItem {
  name: string;
  conDesignSetId: string;
  conDesignItemId: string;
}

interface ManualTemplateGridProps {
  templates: ConDesignItem[];
  onSelect: (template: ConDesignItem) => void;
  disabled?: boolean;
}

export function ManualTemplateGrid({ templates, onSelect, disabled }: ManualTemplateGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 animate-[ve-fade-in_0.3s_ease-out]">
      {templates.map((template) => (
        <TemplateCard
          key={template.conDesignItemId}
          template={template}
          onSelect={() => onSelect(template)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function TemplateCard({ template, onSelect, disabled }: { template: ConDesignItem, onSelect: () => void, disabled?: boolean }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getTemplatePictureUrl(template.conDesignSetId, template.conDesignItemId)
      .then(url => {
        if (active) {
          setImgUrl(url);
          setLoading(false);
        }
      })
      .catch(e => {
        console.error("Failed to load template image", e);
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.conDesignSetId, template.conDesignItemId]);

  return (
    <div
      className={`
        relative flex flex-col items-center p-2 rounded-xl border text-center
        transition-all duration-200 bg-bg-secondary
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:scale-[1.02] hover:bg-bg-quaternary border-border-primary/40'}
      `}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      {/* Icon / Image */}
      <div className="w-full h-24 flex items-center justify-center bg-white rounded-lg mb-2 overflow-hidden border border-border-primary/20">
        {loading ? (
          <span className="text-xs text-text-secondary animate-pulse">Yükleniyor...</span>
        ) : imgUrl ? (
          <img src={imgUrl} alt={template.name} className="w-full h-full object-contain mix-blend-multiply" />
        ) : (
          <span className="text-3xl">🔩</span>
        )}
      </div>

      {/* Name */}
      <h3 className="text-[10px] font-medium text-text-primary leading-tight line-clamp-2" title={template.name}>
        {template.name}
      </h3>
    </div>
  );
}
