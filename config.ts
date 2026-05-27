import 'dotenv/config';
import {getAddress} from 'ethers';

// Функция-помощник для проверки обязательных переменных
export const getEnv = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing env variable: ${key}`);

    return value;
};

// Задаем список всех поддерживаемых токенов
export type SupportedToken = 'USDC' | 'OP' | 'ETH' | 'WETH' | 'cbBTC';

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

// Настройки
export const WATCH_ADDRESS = '0x08d01ebaD78C6Dc1DfFC7c244d90C1143E906FEB';
export const RPC = CONFIG.NETWORKS[CONFIG.CHAIN].RPC_URL;
export const SELL_TOKEN = 'WETH';
export const BUY_TOKEN = 'USDC';//'OP';

import {ethers} from 'ethers';
export const provider = new ethers.JsonRpcProvider(RPC,
    undefined,
    {batchMaxCount: 1} // Запрещаем собирать более 1 запроса в пакет);
);

// config.ts

export const MOONWELL_MARKETS = {
    OPT: {
        M_TOKENS: {
            USDC:   "0x8E08617b0d66359D73Aa11E11017834C29155525",
            USDT:   "0xa3A53899EE8f9f6E963437C5B3f805FEc538BF84",
            DAI:    "0x3FE782C2Fe7668C2F1Eb313ACf3022a31feaD6B2",
            WBTC:   "0x6e6CA598A06E609c913551B729a228B023f06fDB",
            WETH:   "0xb4104C02BBf4E9be85AAa41a62974E4e28D59A33",
            wstETH: "0xbb3b1aB66eFB43B10923b87460c0106643B83f9d",
            cbETH:  "0x95C84F369bd0251ca903052600A3C96838D78bA1",
            rETH:   "0x4c2E35E3eC4A0C82849637BC04A4609Dbe53d321",
            VELO:   "0x866b838b97Ee43F2c818B3cb5Cc77A0dc22003Fc",
            OP:     "0x9fc345a20541Bf8773988515c5950eD69aF01847",
            weETH:  "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3",
            wrsETH: "0x181bA797ccF779D8aB339721ED6ee827E758668e",
            USDT0:  "0xed37cD7872c6fe4020982d35104bE7919b8f8b33"
        }
    },
    BASE: {
        M_TOKENS: {
            USDC:   "0x703843C3379b52F9FF486c9f5892218d2a065cC8", // Нативный mUSDC на Base
            WETH:   "0x628ff693426583D9a7FB391E54366292F509D457",
            cbBTC:  "0xc3090f41Eb54A7f18587FD6651d4D3ab477b07a4",
            cbETH:  "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5",
            WELL:   "0x22b1a40e3178fe7c7109efcc247c5bb2b34abe32"
        }
    }
} as const;

