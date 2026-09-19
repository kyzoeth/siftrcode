import { skeletonizeTypeScript } from '../skeleton/typescript';
import { skeletonizePython } from '../skeleton/python';

console.log('--- Testing TypeScript Skeletonizer ---');
const sampleTS = `
import { Database } from './db';

export interface User {
  id: string;
  email: string;
}

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    console.log("Connecting...");
  }

  /** Gets a user by ID */
  public async getUser(id: string): Promise<User | null> {
    const raw = await this.db.query("SELECT * FROM users WHERE id = ?", [id]);
    if (!raw) return null;
    return { id: raw.id, email: raw.email };
  }

  public deleteUser(id: string): boolean {
    for (let i = 0; i < 10; i++) {
      console.log("deleting", i);
    }
    return true;
  }
}

export const formatUserName = (user: User): string => {
  const parts = user.email.split('@');
  return parts[0].toUpperCase();
};
`;

const tsResult = skeletonizeTypeScript(sampleTS, 'UserService.ts');
console.log('Original Lines:', tsResult.originalLines, '-> Skeleton Lines:', tsResult.skeletonLines);
console.log('Token Reduction:', (tsResult.reductionRatio * 100).toFixed(1) + '%');
console.log('Symbols Extracted:', tsResult.symbols);
console.log('\nGenerated TS Skeleton:\n' + tsResult.skeletonContent);

console.log('--- Testing Python Skeletonizer ---');
const samplePY = `
from typing import Optional, List

class OrderService:
    """Manages customer orders and checkout."""
    def __init__(self, stripe_key: str):
        self.key = stripe_key
        self._init_client()

    def process_order(self, order_id: str, amount: float) -> bool:
        """Processes transaction with Stripe."""
        data = {"id": order_id, "amt": amount}
        for attempt in range(3):
            try:
                res = self.post(data)
                return True
            except Exception:
                continue
        return False

def calculate_discount(tier: str, total: float) -> float:
    \"\"\"Calculates tier discount.\"\"\"
    if tier == "vip":
        return total * 0.2
    return 0.0
`;

const pyResult = skeletonizePython(samplePY, 'order_service.py');
console.log('Original Lines:', pyResult.originalLines, '-> Skeleton Lines:', pyResult.skeletonLines);
console.log('Token Reduction:', (pyResult.reductionRatio * 100).toFixed(1) + '%');
console.log('Symbols Extracted:', pyResult.symbols);
console.log('\nGenerated Python Skeleton:\n' + pyResult.skeletonContent);
