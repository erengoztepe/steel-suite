import React, { useState, useMemo } from 'react';
import classNames from 'classnames';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts';

export interface StandardizationDashboardProps {
  onClose: () => void;
}

interface RawDataItem {
  file: string;
  connection: string;
  category: 'Plate' | 'Weld' | 'Bolt';
  size_label: string;
}

export function StandardizationDashboard({ onClose }: StandardizationDashboardProps) {
  const [folderPath, setFolderPath] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RawDataItem[]>([]);
  const [activeTab, setActiveTab] = useState<'Plate' | 'Weld' | 'Bolt'>('Plate');
  const [selectedSize, setSelectedSize] = useState<string | null>(null);

  const handleScan = async () => {
    if (!folderPath) return;
    setIsScanning(true);
    setError(null);
    setData([]);
    setSelectedSize(null);

    try {
      const response = await fetch('/api/standardization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });

      const json = await response.json();
      
      if (!response.ok || json.error) {
        throw new Error(json.error || 'Tarama sırasında hata oluştu.');
      }

      setData(json.data || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsScanning(false);
    }
  };

  // Filter data by current tab
  const tabData = useMemo(() => data.filter(d => d.category === activeTab), [data, activeTab]);

  // Aggregate data for the chart: { size_label: string, count: number, numericSort: number }
  const chartData = useMemo(() => {
    const counts: Record<string, number> = {};
    tabData.forEach(d => {
      counts[d.size_label] = (counts[d.size_label] || 0) + 1;
    });

    const arr = Object.keys(counts).map(label => {
      // Extract numeric value for sorting
      // "12.0 mm" -> 12, "a5.0" -> 5, "M16 8.8" -> 16
      const numMatch = label.match(/[\d.]+/);
      const num = numMatch ? parseFloat(numMatch[0]) : 0;
      return { size_label: label, count: counts[label], numericSort: num };
    });

    // Sort by numeric size (smallest to largest) as requested
    arr.sort((a, b) => a.numericSort - b.numericSort);
    return arr;
  }, [tabData]);

  // Filter instances for the table based on selected bar
  const tableData = useMemo(() => {
    if (!selectedSize) return tabData;
    return tabData.filter(d => d.size_label === selectedSize);
  }, [tabData, selectedSize]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-surface/90 backdrop-blur-md p-6">
      <div className="bg-brand-surface border border-brand-secondary/20 shadow-2xl rounded-2xl w-full h-full max-w-7xl max-h-[95vh] flex flex-col relative overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-brand-secondary/10 shrink-0 bg-brand-surface">
          <div>
            <h2 className="text-xl font-bold text-brand-primary flex items-center gap-2">
              <svg className="w-6 h-6 text-brand-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Proje Standartlaştırma Özeti
            </h2>
            <p className="text-xs text-brand-primary/50 mt-1">
              Projendeki farklı birleşim dosyalarındaki plaka, kaynak ve cıvata standartlarını analiz et.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-brand-secondary/10 text-brand-primary/50 hover:text-brand-primary transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Top Bar - Controls */}
        <div className="px-6 py-4 border-b border-brand-secondary/10 bg-bg-secondary shrink-0 flex items-end gap-4">
          <div className="flex-1">
            <label className="block text-xs font-medium text-brand-primary/70 mb-2">
              IDEA StatiCa (.ideaCon) Klasör Yolu
            </label>
            <input
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              className="w-full bg-brand-surface border border-brand-secondary/20 rounded-lg px-4 py-2.5 text-sm text-brand-primary focus:outline-none focus:border-brand-secondary transition-colors"
              placeholder="Örn: C:\Projects\Steel\Connections"
              onKeyDown={(e) => e.key === 'Enter' && handleScan()}
            />
          </div>
          <button
            onClick={handleScan}
            disabled={isScanning || !folderPath}
            className="px-6 py-2.5 bg-brand-secondary hover:bg-brand-secondary/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isScanning ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Taranıyor...
              </>
            ) : (
              'Klasörü Tara'
            )}
          </button>
        </div>

        {error && (
          <div className="mx-6 mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-500 shrink-0">
            {error}
          </div>
        )}

        {/* Main Content Area */}
        {data.length > 0 ? (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Tabs */}
            <div className="flex px-6 pt-4 border-b border-brand-secondary/10 shrink-0">
              {['Plate', 'Weld', 'Bolt'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab as any);
                    setSelectedSize(null);
                  }}
                  className={classNames(
                    "px-6 py-3 text-sm font-medium border-b-2 transition-colors",
                    activeTab === tab
                      ? "border-brand-secondary text-brand-secondary"
                      : "border-transparent text-brand-primary/60 hover:text-brand-primary hover:border-brand-secondary/30"
                  )}
                >
                  {tab === 'Plate' ? 'Plakalar' : tab === 'Weld' ? 'Kaynaklar' : 'Cıvatalar'}
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-brand-secondary/10 text-brand-secondary text-[10px]">
                    {data.filter(d => d.category === tab).length}
                  </span>
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Left Column - Chart */}
              <div className="w-1/2 p-6 border-r border-brand-secondary/10 flex flex-col min-h-0">
                <h3 className="text-sm font-medium text-brand-primary mb-1">
                  Kullanım Sıklığı (Ebatlara Göre)
                </h3>
                <p className="text-xs text-brand-primary/50 mb-6">
                  Detayları görmek için grafikteki bir çubuğa tıklayın.
                </p>
                
                <div className="flex-1 min-h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff1a" vertical={false} />
                      <XAxis 
                        dataKey="size_label" 
                        stroke="#8b949e" 
                        fontSize={12}
                        tickMargin={10}
                      />
                      <YAxis 
                        stroke="#8b949e" 
                        fontSize={12}
                        allowDecimals={false}
                      />
                      <Tooltip 
                        cursor={{fill: '#ffffff0a'}}
                        contentStyle={{ backgroundColor: '#161b22', borderColor: '#30363d', borderRadius: '8px' }}
                        itemStyle={{ color: '#c9d1d9' }}
                      />
                      <Bar 
                        dataKey="count" 
                        name="Kullanım Sayısı"
                        radius={[4, 4, 0, 0]}
                        onClick={(data: any) => {
                          setSelectedSize(data.size_label === selectedSize ? null : data.size_label);
                        }}
                      >
                        {chartData.map((entry, index) => (
                          <Cell 
                            cursor="pointer"
                            key={`cell-${index}`} 
                            fill={entry.size_label === selectedSize ? '#38bdf8' : '#0ea5e980'} 
                            className="hover:opacity-80 transition-opacity"
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Right Column - Table */}
              <div className="w-1/2 p-6 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-medium text-brand-primary">
                    {selectedSize ? (
                      <span><strong className="text-brand-secondary">{selectedSize}</strong> kullanan birleşimler</span>
                    ) : (
                      'Tüm Birleşimler'
                    )}
                  </h3>
                  {selectedSize && (
                    <button 
                      onClick={() => setSelectedSize(null)}
                      className="text-xs text-brand-primary/50 hover:text-brand-primary underline"
                    >
                      Filtreyi Temizle
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-auto border border-brand-secondary/10 rounded-xl">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-brand-surface border-b border-brand-secondary/10 text-brand-primary/70 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 font-medium">Dosya</th>
                        <th className="px-4 py-3 font-medium">Bağlantı</th>
                        <th className="px-4 py-3 font-medium">Ebat</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-secondary/10 bg-brand-surface/50 text-brand-primary">
                      {tableData.map((item, idx) => (
                        <tr key={idx} className="hover:bg-brand-surface transition-colors">
                          <td className="px-4 py-3 font-medium">{item.file}</td>
                          <td className="px-4 py-3 text-brand-primary/80">{item.connection}</td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-1 bg-brand-secondary/10 text-brand-secondary rounded-md text-xs">
                              {item.size_label}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 text-xs text-brand-primary/50 text-right">
                  Toplam: {tableData.length} kayıt gösteriliyor
                </div>
              </div>
            </div>
          </div>
        ) : (
          !isScanning && !error && (
            <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50 p-6">
              <svg className="w-20 h-20 mb-6 text-brand-secondary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <h3 className="text-lg text-brand-primary font-medium mb-2">Dashboard Boş</h3>
              <p className="text-brand-primary text-sm max-w-md">
                Lütfen yukarıya .ideaCon dosyalarının bulunduğu bir klasör yolu girip "Klasörü Tara" butonuna tıklayın. 
                (Bu işlem dosya sayısına göre biraz zaman alabilir)
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
