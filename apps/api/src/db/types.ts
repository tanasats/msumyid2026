import type { Pool, PoolClient } from 'pg';

// repository รับได้ทั้ง pool (คำสั่งเดียว) และ client (อยู่ใน withTransaction)
export type Queryable = Pool | PoolClient;
