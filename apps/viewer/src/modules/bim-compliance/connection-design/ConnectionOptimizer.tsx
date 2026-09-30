import React, { useState } from 'react';
import classNames from 'classnames';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

export interface ConnectionOptimizerProps {
  projectId: string;
  connectionId: number;
  onClose: () => void;
}

interface HistoryItem {
  iteration: number;
  value: number;
  status: 'PASS' | 'FAIL';
  max_utilization: number;
  cost: number;
}

export function ConnectionOptimizer({ projectId, connectionId, onClose }: ConnectionOptimizerProps) {
  const [parameter, setParameter] = useState('Plate_Thickness~1');
  const [rangeStr, setRangeStr] = useState('20, 15, 12, 10, 8, 5');
  const [direction, setDirection] = useState<'DECREASING' | 'INCREASING' | 'UNORDERED'>('DECREASING');
  
  const [isSweeping, setIsSweeping] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleSweep = async () => {
    setIsSweeping(true);
    setError(null);
    setHistory([]);

    try {
      const response = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          connectionId,
          parameter,
          range: rangeStr,
          direction,
        }),
      });

      const data = await response.json();
      
      if (!response.ok || data.error) {
        throw new Error(data.error || 'Optimizasyon sırasında bir hata oluştu');
      }

      setHistory(data.history || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsSweeping(false);
    }
  };

  const chartData = history.map((h) => ({
    ...h,
    label: `${h.value}`,
  }));

  const bestPassing = history.find(h => h.status === 'PASS'); // Assuming decreasing order usually finds the best last

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-surface/80 backdrop-blur-sm p-4">
      <div className="bg-brand-surface border border-brand-secondary/20 shadow-2xl rounded-2xl w-full max-w-5xl flex flex-col max-h-[90vh] overflow-hidden relative">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-brand-secondary/10">
          <h2 className="text-lg font-semibold text-brand-primary">Parametre Optimizasyonu</h2>
          <button
            onClick={onClose}
            className="text-brand-primary/50 hover:text-brand-primary transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar - Controls */}
          <div className="w-80 border-r border-brand-secondary/10 p-6 flex flex-col gap-6 overflow-y-auto">
            
            <div>
              <label className="block text-xs font-medium text-brand-primary/70 mb-2">
                Hedef Parametre
              </label>
              <input
                type="text"
                value={parameter}
                onChange={(e) => setParameter(e.target.value)}
                className="w-full bg-brand-surface border border-brand-secondary/20 rounded-lg px-3 py-2 text-sm text-brand-primary focus:outline-none focus:border-brand-secondary transition-colors"
                placeholder="Örn: Plate_Thickness~1"
              />
              <p className="text-[10px] text-brand-primary/50 mt-1">IDEA StatiCa Developer sekmesindeki parametre adını girin.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-brand-primary/70 mb-2">
                Test Edilecek Değerler (Aralık)
              </label>
              <input
                type="text"
                value={rangeStr}
                onChange={(e) => setRangeStr(e.target.value)}
                className="w-full bg-brand-surface border border-brand-secondary/20 rounded-lg px-3 py-2 text-sm text-brand-primary focus:outline-none focus:border-brand-secondary transition-colors"
                placeholder="Örn: 20, 15, 12, 10, 8, 5"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-brand-primary/70 mb-2">
                Tarama Modu
              </label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as any)}
                className="w-full bg-brand-surface border border-brand-secondary/20 rounded-lg px-3 py-2 text-sm text-brand-primary focus:outline-none focus:border-brand-secondary transition-colors appearance-none"
              >
                <option value="DECREASING">Büyükten Küçüğe (Azalan)</option>
                <option value="INCREASING">Küçükten Büyüğe (Artan)</option>
                <option value="UNORDERED">Sırasız (Tümünü Dene)</option>
              </select>
            </div>

            <button
              onClick={handleSweep}
              disabled={isSweeping}
              className="mt-4 w-full bg-brand-secondary hover:bg-brand-secondary/90 text-white rounded-xl py-3 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {isSweeping ? 'Hesaplanıyor...' : 'Taramayı Başlat'}
            </button>

            {error && (
              <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500">
                {error}
              </div>
            )}
          </div>

          {/* Main Area - Results */}
          <div className="flex-1 p-6 flex flex-col overflow-y-auto bg-brand-surface/50">
            {history.length > 0 ? (
              <>
                {/* Chart Area */}
                <div className="bg-brand-surface rounded-xl border border-brand-secondary/10 p-4 shadow-sm mb-6 h-72">
                  <h3 className="text-sm font-medium text-brand-primary mb-4">Maliyet Analizi</h3>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" />
                      <XAxis 
                        dataKey="label" 
                        stroke="#8b949e" 
                        fontSize={12}
                        label={{ value: 'Parametre Değeri', position: 'insideBottom', offset: -10, fill: '#8b949e' }}
                      />
                      <YAxis 
                        stroke="#8b949e" 
                        fontSize={12}
                        label={{ value: 'Maliyet', angle: -90, position: 'insideLeft', fill: '#8b949e' }}
                      />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#161b22', borderColor: '#30363d', borderRadius: '8px' }}
                        itemStyle={{ color: '#c9d1d9' }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="cost" 
                        stroke="#38bdf8" 
                        strokeWidth={2}
                        activeDot={{ r: 6 }} 
                        name="Üretim Maliyeti"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Table Area */}
                <div>
                  <h3 className="text-sm font-medium text-brand-primary mb-3">İterasyon Geçmişi</h3>
                  <div className="border border-brand-secondary/10 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-brand-surface border-b border-brand-secondary/10 text-brand-primary/70">
                        <tr>
                          <th className="px-4 py-3 font-medium">İterasyon</th>
                          <th className="px-4 py-3 font-medium">Değer</th>
                          <th className="px-4 py-3 font-medium">Durum</th>
                          <th className="px-4 py-3 font-medium">Maks. Kapasite</th>
                          <th className="px-4 py-3 font-medium">Maliyet</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-secondary/10 bg-brand-surface/50 text-brand-primary">
                        {history.map((item, idx) => (
                          <tr key={idx} className="hover:bg-brand-surface transition-colors">
                            <td className="px-4 py-3">#{item.iteration}</td>
                            <td className="px-4 py-3 font-medium">{item.value}</td>
                            <td className="px-4 py-3">
                              <span className={classNames(
                                "px-2 py-1 rounded-md text-[11px] font-bold uppercase",
                                item.status === 'PASS' 
                                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                                  : "bg-red-500/10 text-red-500 border border-red-500/20"
                              )}>
                                {item.status}
                              </span>
                            </td>
                            <td className="px-4 py-3">{item.max_utilization.toFixed(1)}%</td>
                            <td className="px-4 py-3 font-mono">{item.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50">
                <svg className="w-16 h-16 mb-4 text-brand-secondary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <p className="text-brand-primary text-sm max-w-sm">
                  Tarama başlatıldığında her adımın maliyeti ve analiz durumu burada canlı olarak grafiklendirilecektir.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
