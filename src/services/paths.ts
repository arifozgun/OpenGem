import path from 'path';

export const PACKAGE_ROOT = path.join(__dirname, '../..');

export function getRuntimeRoot(): string {
    const configuredRoot = process.env.OPENGEM_HOME;
    if (configuredRoot && configuredRoot.trim()) {
        return path.resolve(configuredRoot);
    }
    return PACKAGE_ROOT;
}

export function getRuntimeEnvPath(): string {
    return path.join(getRuntimeRoot(), '.env');
}

export function getConfigPath(): string {
    return path.join(getRuntimeRoot(), 'config.json');
}

export function getDataDir(): string {
    return path.join(getRuntimeRoot(), 'data');
}
