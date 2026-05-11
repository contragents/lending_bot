import 'dotenv/config';
import {getAddress} from 'ethers';

// Функция-помощник для проверки обязательных переменных
const getEnv = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing env variable: ${key}`);

    return value;
};

export const CONFIG = {
    // Рабочая сеть
    CHAIN: 'BASE', // OPT
    // Настройки сетей
    RPC: {
        OPT: getEnv('OPTIMISM_RPC_URL'),
        BASE: getEnv('BASE_RPC_URL'),
    },

    // Адреса контрактов (нормализованные через getAddress)
    MOONWELL: {
        // Здесь мы явно говорим, что ключами могут быть любые строки
        BASE: {
            COMPTROLLER: getAddress("0xfBb211A5396424b2D3929156708854D7474f0221"), // Base
        },
        OPT: {
            COMPTROLLER: getAddress('0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9'), // Optimism
        },
        ABI: [
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


// Адрес Comptroller Moonwell на Base
const MOONWELL_COMPTROLLER_ADDRESS_BASE = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const MOONWELL_COMPTROLLER_ADDRESS_OPT = '0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9';
const MOONWELL_ABI = [
    "function getAccountLiquidity(address account) view returns (uint, uint, uint)",
    "function getAllMarkets() view returns (address[])"
];