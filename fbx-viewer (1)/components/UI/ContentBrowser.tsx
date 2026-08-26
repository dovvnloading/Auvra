import React, { useState } from 'react';
import { Search, Filter, Plus, Component, User, Image, Swords } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { AssetCategory } from '../../types';

export const ContentBrowser: React.FC = () => {
  const { models, addModel, selectModel, isLoading } = useScene();
  const [filter, setFilter] = useState<AssetCategory | 'All'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [isImportOpen, setIsImportOpen] = useState(false);

  const filteredModels = models.filter(m => {
      const matchesFilter = filter === 'All' || m.category === filter;
      const matchesSearch = m.name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesFilter && matchesSearch;
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, category: AssetCategory) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      setIsImportOpen(false); // Close dropdown immediately
      
      // Process serially or in parallel. 
      // Serially is safer for heavy FBX parsing on main thread to avoid total freeze, 
      // though simple loop is fine here.
      for (const file of files) {
          await addModel(file, category);
      }
    }
    e.target.value = ''; 
  };

  return (
    <div className="h-64 bg-gray-900/95 backdrop-blur-md border-t border-white/10 flex flex-col shadow-[0_-4px_16px_rgba(0,0,0,0.5)] z-10">
      
      {/* Toolbar */}
      <div className="h-10 border-b border-white/10 flex items-center px-2 bg-gray-850/50 justify-between shrink-0">
         <div className="flex items-center gap-2">
            {/* Add Button */}
            <div className="relative">
                <button 
                    onClick={() => setIsImportOpen(!isImportOpen)}
                    disabled={isLoading}
                    className={`
                        flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold transition-all
                        ${isImportOpen ? 'bg-gray-700 text-white' : 'bg-white hover:bg-gray-200 text-black shadow-lg shadow-white/10'}
                        ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                >
                    <Plus size={14} />
                    Import
                </button>

                {isImportOpen && (
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setIsImportOpen(false)} />
                        <div className="absolute bottom-full left-0 mb-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden py-1">
                            <div className="px-3 py-2 text-[10px] uppercase text-gray-500 font-bold tracking-wider border-b border-gray-700/50 mb-1">
                                Asset Type
                            </div>
                            {(['Character', 'Prop', 'Environment', 'Weapon'] as AssetCategory[]).map(cat => (
                                <label key={cat} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-700 hover:text-white cursor-pointer group transition-colors">
                                    {cat === 'Character' && <User size={14} className="text-gray-500 group-hover:text-white" />}
                                    {cat === 'Prop' && <Component size={14} className="text-gray-500 group-hover:text-white" />}
                                    {cat === 'Environment' && <Image size={14} className="text-gray-500 group-hover:text-white" />}
                                    {cat === 'Weapon' && <Swords size={14} className="text-gray-500 group-hover:text-white" />}
                                    <span className="text-sm text-gray-300 group-hover:text-white">{cat}</span>
                                    <input 
                                        type="file" 
                                        accept=".fbx"
                                        multiple 
                                        className="hidden" 
                                        onChange={(e) => handleFileUpload(e, cat)} 
                                    />
                                </label>
                            ))}
                        </div>
                    </>
                )}
            </div>
            
            <div className="w-px h-6 bg-gray-700 mx-2"></div>

            {/* Filters */}
            <div className="flex bg-gray-900 rounded p-0.5 border border-gray-700">
                {(['All', 'Character', 'Prop', 'Environment', 'Weapon'] as const).map(f => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-3 py-1 text-[10px] rounded font-medium transition-colors ${filter === f ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                        {f}
                    </button>
                ))}
            </div>
         </div>

         {/* Search */}
         <div className="relative">
             <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
             <input 
                type="text" 
                placeholder="Search assets..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-gray-950/50 border border-gray-700 rounded-full py-1 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-gray-500 w-48 transition-all focus:w-64"
             />
         </div>
      </div>

      {/* Grid Content */}
      <div className="flex-1 overflow-y-auto p-4 bg-transparent custom-scrollbar">
         {filteredModels.length === 0 ? (
             <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-2">
                 <Filter size={32} className="opacity-20" />
                 <p className="text-sm">No items found.</p>
                 <p className="text-xs">Import a new asset to get started.</p>
             </div>
         ) : (
             <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-4">
                 {filteredModels.map(model => (
                     <div 
                        key={model.id}
                        onClick={() => selectModel(model.id)}
                        className="group relative flex flex-col gap-1 cursor-pointer"
                     >
                         {/* Thumbnail Card */}
                         <div className="aspect-square bg-gray-800 rounded-md border border-gray-700 overflow-hidden group-hover:border-white transition-colors shadow-sm relative">
                             {model.thumbnail ? (
                                 <img src={model.thumbnail} alt={model.name} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity grayscale" />
                             ) : (
                                 <div className="w-full h-full flex items-center justify-center text-gray-600">
                                     <Component size={24} />
                                 </div>
                             )}
                             
                             {/* Type Badge */}
                             <div className="absolute top-1 right-1 p-1 bg-gray-900/80 backdrop-blur rounded text-gray-400">
                                {model.category === 'Character' && <User size={10} className="text-gray-400" />}
                                {model.category === 'Prop' && <Component size={10} className="text-gray-400" />}
                                {model.category === 'Environment' && <Image size={10} className="text-gray-400" />}
                                {model.category === 'Weapon' && <Swords size={10} className="text-gray-400" />}
                             </div>
                         </div>
                         
                         {/* Label */}
                         <span className="text-[11px] text-gray-400 group-hover:text-white truncate px-0.5 text-center">
                             {model.name}
                         </span>
                     </div>
                 ))}
             </div>
         )}
      </div>

      {/* Status Bar */}
      <div className="h-6 bg-gray-950/80 border-t border-white/10 flex items-center px-3 justify-between shrink-0">
          <div className="text-[10px] text-gray-500">
              {models.length} Items ({filteredModels.length} filtered)
          </div>
          {isLoading && (
              <div className="flex items-center gap-2 text-[10px] text-white">
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                  Processing...
              </div>
          )}
      </div>
    </div>
  );
};