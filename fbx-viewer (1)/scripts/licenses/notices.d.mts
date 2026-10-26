export interface ProductionPackage { dir: string; name: string; version: string }
export declare function productionPackages(root: string): ProductionPackage[];
export declare function collectThirdPartyNotices(root: string): string;
