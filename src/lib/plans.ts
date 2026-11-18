/**
 * Storage plans advertised on the landing page once the admin opens the
 * public launch (see `publicMode` in convex/admin.ts), and listed in the
 * Admin area next to the switch. Each school gets its own vault; the plans
 * differ by how much storage that vault may hold. Edit this list to change
 * what the site offers.
 */
export interface StoragePlan {
  name: string;
  /** Headline price, e.g. "Free" or "$9". */
  price: string;
  /** What the price covers, e.g. "per month". */
  cadence: string;
  storage: string;
  blurb: string;
  features: string[];
  /** Highlighted on the landing page. */
  featured?: boolean;
}

export const STORAGE_PLANS: StoragePlan[] = [
  {
    name: "Solo",
    price: "Free",
    cadence: "for one class",
    storage: "1 GB",
    blurb: "A single teacher trying NatyaVault out with their class.",
    features: [
      "One class, up to 15 students",
      "1 GB of vault storage",
      "Folders, practice logs, and messages",
    ],
  },
  {
    name: "Studio",
    price: "$9",
    cadence: "per month",
    storage: "25 GB",
    blurb: "A growing school running several classes at once.",
    features: [
      "Unlimited students",
      "25 GB of vault storage",
      "Import from your own Google Drive",
      "Priority email support",
    ],
    featured: true,
  },
  {
    name: "Academy",
    price: "$29",
    cadence: "per month",
    storage: "100 GB",
    blurb: "A full academy keeping years of performances on file.",
    features: [
      "Unlimited students and teachers",
      "100 GB of vault storage",
      "Import from your own Google Drive",
      "Priority email support",
    ],
  },
];
