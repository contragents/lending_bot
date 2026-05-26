import 'dotenv/config';
import {getAddress} from 'ethers';

// Функция-помощник для проверки обязательных переменных
export const getEnv = (key: string): string => {
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
        { default: number } &
        // Разрешаем ЛЮБОЙ другой строковый ключ со значением number
        { [key: string]: number };
    ZEROX_API_KEY: string;
    SLIPPAGE: number;
    INTEGRATOR_ID: string,
    NETWORKS: {
        [key in ChainType]: NetworkSettings;
    };
    ABI: {
        MOONWELL: string[];
        UNISWAP: string[];
        ORACLE: string[];
        UNISWAP_ROUTER: string[];
    };
}

export const CONFIG: AppConfig = {
    CHAIN: 'OPT', //'BASE', // OPT
    TOKEN_DECIMALS: {
        USDC: 6,
        default: 18,
        cbBTC: 8,
        WBTC: 8,
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
            "function getAllMarkets() view returns (address[])",
            // Добавляем ABI для самих mToken контрактов
            "function symbol() view returns (string)",
            "function underlying() view returns (address)",
            "function getAccountSnapshot(address account) view returns (uint256 err, uint256 mTokenBalance, uint256 borrowBalance, uint256 exchangeRateStored)",
        ],
        UNISWAP: [
            "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)",
            "function liquidity() view returns (uint128)",
            "function fee() view returns (uint24)",
        ],
        ORACLE: [
            "function l1BaseFee() view returns (uint256)",
            "function blobBaseFee() view returns (uint256)",
            "function baseFeeScalar() view returns (uint32)",
            "function blobBaseFeeScalar() view returns (uint32)",
            "function decimals() view returns (uint256)",
        ],
        UNISWAP_ROUTER: [
            "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
        ],
    },
    // Параметры для API
    ZEROX_API_KEY: getEnv('ZEROX_API_KEY'),
    // Параметры бота
    INTEGRATOR_ID: 'lifi', // или ваш ID
    SLIPPAGE: 0.005,      // 0.5%
};

export const LENDING = {
    OPT: {
        '294789510': {
            ID: 4,
            PAIR_IDS: {
                OP: 122,
                USDC: 100,
                WETH: 132,
            }
        }
    },
    BASE: {
        '294789510': {
            ID: 2,
            PAIR_IDS: {
                OP: 122,
                USDC: 100,
                WETH: 132,
                cbBTC: 136,
                MAMO: 134,
                WELL: 139,
            }
        }
    },
}

export const POOLS = {
    OPT: {
        EthOp005: "0xFC1f3296458F9b2a27a0B91dd7681C4020E09D05", // Пул 0.05%
        EthOp03: "0x68F5C0A2DE713a54991E01858Fd27a3832401849", // Пул 0.3%
        OracleAddress: "0x420000000000000000000000000000000000000F", // Optimism GasPriceOracle
    },
}
