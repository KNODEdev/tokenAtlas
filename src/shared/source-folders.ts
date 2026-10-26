export interface SourceFolderListing {
  path: string;
  parent: string | null;
  roots: string[];
  folders: Array<{ name: string; path: string }>;
}
