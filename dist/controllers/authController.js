"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSettings = exports.verifyToken = exports.login = exports.signup = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../utils/prisma");
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';
const signup = async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const existingUser = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        const user = await prisma_1.prisma.user.create({
            data: { email, passwordHash, name }
        });
        const token = jsonwebtoken_1.default.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
};
exports.signup = signup;
const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const validPassword = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const token = jsonwebtoken_1.default.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name, uiStorage: user.uiStorage } });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
};
exports.login = login;
const verifyToken = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const user = await prisma_1.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        res.json({ user: { id: user.id, email: user.email, name: user.name, uiStorage: user.uiStorage } });
    }
    catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
};
exports.verifyToken = verifyToken;
const saveSettings = async (req, res) => {
    // @ts-ignore
    const userId = req.userId;
    try {
        const { uiStorage } = req.body;
        await prisma_1.prisma.user.update({
            where: { id: userId },
            data: { uiStorage: JSON.stringify(uiStorage) }
        });
        res.json({ success: true });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to save settings' });
    }
};
exports.saveSettings = saveSettings;
