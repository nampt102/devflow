import type { RequiresHumanReason } from "./schema.js";

// Deterministic "needs a human" flags, computed from the request text on the server so the flag
// does not depend on the model choosing to raise it. Over-flagging is the safe direction.
// ponytail: keyword list per language; replace with config/learned rules once override data exists.

const RULES: Array<[RequiresHumanReason, RegExp]> = [
  ["sqlserver_migration", /sql\s*server|mssql|migrat\w*\s+(sql|db|database|csdl)|(chuyen|doi)\s+(sang\s+)?(csdl|co so du lieu|database)/],
  ["production_change", /\b(production|prod)\b|moi truong (that|production|thuc te)|(trien khai|deploy)\s+(len\s+)?(that|production|prod)/],
  ["data_fix", /(sua|fix|chinh sua|cap nhat|update|xoa|delete)\s+(truc tiep\s+)?(du lieu|data|database|db|csdl)\b/],
  ["security_or_permission", /phan quyen|quyen truy cap|permission|password|mat khau|bao mat|security|vulnerab|lo hong|\brole\b/],
  ["external_integration", /tich hop|integrat|webhook|api (ben thu|cua doi tac|ngoai)|\berp\b|\bsap\b|\bsso\b|\bldap\b/],
  ["finance_or_payroll_data", /\bluong\b|payroll|ke toan|hoa don|invoice|thanh toan|payment|tai chinh|\bthue\b/],
];

/** Lowercase and strip Vietnamese diacritics so "SQL Server" and "cơ sở dữ liệu" match one pattern. */
export function normalizeForRules(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

export function ruleFlags(...texts: Array<string | null | undefined>): RequiresHumanReason[] {
  const haystack = normalizeForRules(texts.filter(Boolean).join("\n"));
  return RULES.filter(([, re]) => re.test(haystack)).map(([name]) => name);
}
