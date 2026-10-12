export interface LegalSection {
  id: string;
  title: string;
  paragraphs: string[];
  bulletPoints?: string[];
  link?: {
    text: string;
    url: string;
  };
}

export interface LegalDocument {
  title: string;
  subtitle: string;
  lastUpdated: string;
  sections: LegalSection[];
}
