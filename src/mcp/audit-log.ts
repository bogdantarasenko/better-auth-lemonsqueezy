export interface AuditLogEntry {
	tool: string;
	parameters: Record<string, unknown>;
	timestamp: string;
	success: boolean;
}

export class AuditLog {
	private entries: AuditLogEntry[] = [];

	add(entry: AuditLogEntry) {
		this.entries.push(entry);
	}

	getEntries(): AuditLogEntry[] {
		return [...this.entries];
	}
}
