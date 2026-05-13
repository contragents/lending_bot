import 'dotenv/config';
import {getAddress} from 'ethers';

// Функция-помощник для проверки обязательных переменных
const getEnv = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing env variable: ${key}`);

    return value;
};

// Задаем список всех поддерживаемых токенов
type SupportedToken = 'USDC' | 'OP' | 'ETH' | 'WETH' | 'cbBTC';

// Описываем структуру для токенов в конкретной сети
type TokenList = {
    [K in SupportedToken]?: string;
};

// Создаем массив сетей в рантайме (as const обязателен)
const CHAINS = ['BASE', 'OPT'] as const;

// 2. Генерируем тип 'BASE' | 'OPT' прямо из массива
type ChainType = typeof CHAINS[number];

// Описываем структуру Moonwell
interface MoonwellConfig {
    COMPTROLLER: string;
}

// Общий интерфейс для настроек конкретной сети
interface NetworkSettings {
    ID: string;
    RPC_URL: string;
    TOKENS: TokenList;
    MOONWELL: MoonwellConfig;
}

// Типизируем весь конфиг
interface AppConfig {
    CHAIN: ChainType; // Ограничиваем выбор сетей
    TOKEN_DECIMALS:
    // Делаем все токены из списка необязательными (через знак ?)
        { [K in SupportedToken]?: number } &
        // И жестко требуем наличие поля default
        { default: number };
    ZEROX_API_KEY: string;
    SLIPPAGE: number;
    INTEGRATOR_ID: string,
    NETWORKS: {
        [key in ChainType]: NetworkSettings;
    };
    ABI: {
        MOONWELL: string[];
    };
}

export const CONFIG: AppConfig = {
    CHAIN: 'OPT', // 'BASE', // OPT
    TOKEN_DECIMALS: {
        USDC: 6,
        default:18,
    },
    NETWORKS: {
        BASE: {

            ID: "8453",
            RPC_URL: getEnv('BASE_RPC_URL'),
            TOKENS: {
                WETH: getAddress("0x4200000000000000000000000000000000000006"),
                USDC: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
            },
            MOONWELL: {
                COMPTROLLER: getAddress("0xfBb21d0380beE3312B33c4353c8936a0F13EF26C"),
            }
        },
        OPT: {
            ID: "10",
            RPC_URL: getEnv('OPTIMISM_RPC_URL'),
            TOKENS: {
                WETH: getAddress("0x4200000000000000000000000000000000000006"),
                USDC: getAddress("0x0b2c639c533813f4aa9d7837caf62653d097ff85"),
                OP: getAddress("0x4200000000000000000000000000000000000042"),
            },
            MOONWELL: {
                COMPTROLLER: getAddress("0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9"),
            }
        }
    },
    ABI: {
        MOONWELL: [
            "function getAccountLiquidity(address account) view returns (uint, uint, uint)",
            "function getAllMarkets() view returns (address[])"
        ]
    },
    // Параметры для API
    ZEROX_API_KEY: getEnv('ZEROX_API_KEY'),
    // Параметры бота
    INTEGRATOR_ID: 'lifi', // или ваш ID
    SLIPPAGE: 0.005,      // 0.5%
};
