import type { Express } from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
import { 
  insertUserSchema, insertCampaignSchema, insertFinancialDonationSchema,
  insertMaterialDonationSchema, insertBoutiqueOrderSchema,
  type User 
} from "@shared/schema";
import { z } from "zod";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Middleware to verify JWT token
const authenticateToken = async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
    const user = await storage.getUser(decoded.userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid token' });
  }
};

// Middleware to verify admin role
const requireAdmin = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};

export async function registerRoutes(app: Express): Promise<Server> {
  // Authentication routes
  app.post('/api/auth/register', async (req, res) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      
      // Check if user already exists
      const existingUser = await storage.getUserByEmail(userData.email);
      if (existingUser) {
        return res.status(400).json({ message: 'User already exists' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(userData.password, 10);
      
      // Generate verification token
      const emailVerificationToken = jwt.sign({ email: userData.email }, JWT_SECRET, { expiresIn: '24h' });
      
      const user = await storage.createUser({
        ...userData,
        passwordHash,
        emailVerificationToken,
      });

      res.status(201).json({ 
        message: 'User created successfully',
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(400).json({ message: 'Invalid user data' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const isValidPassword = await bcrypt.compare(password, user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
      
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          isVerified: user.isVerified
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.get('/api/auth/verify-email', async (req, res) => {
    try {
      const { token } = req.query;
      
      const decoded = jwt.verify(token as string, JWT_SECRET) as { email: string };
      const user = await storage.getUserByEmail(decoded.email);
      
      if (!user) {
        return res.status(400).json({ message: 'Invalid verification token' });
      }

      await storage.updateUser(user.id, { 
        isVerified: true, 
        emailVerificationToken: null 
      });

      res.json({ message: 'Email verified successfully' });
    } catch (error) {
      res.status(400).json({ message: 'Invalid or expired token' });
    }
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      
      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const resetToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
      
      await storage.updateUser(user.id, { passwordResetToken: resetToken });

      res.json({ message: 'Password reset email sent' });
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { token, password } = req.body;
      
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
      const user = await storage.getUser(decoded.userId);
      
      if (!user || user.passwordResetToken !== token) {
        return res.status(400).json({ message: 'Invalid reset token' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      
      await storage.updateUser(user.id, { 
        passwordHash, 
        passwordResetToken: null 
      });

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      res.status(400).json({ message: 'Invalid or expired token' });
    }
  });

  app.get('/api/auth/me', authenticateToken, async (req, res) => {
    res.json({ user: req.user });
  });

  // Campaign routes
  app.get('/api/campaigns', async (req, res) => {
    try {
      const { status = 'approved', limit } = req.query;
      const campaigns = await storage.getCampaigns(status as string, limit ? parseInt(limit as string) : undefined);
      res.json(campaigns);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching campaigns' });
    }
  });

  app.get('/api/campaigns/:id', async (req, res) => {
    try {
      const campaign = await storage.getCampaign(parseInt(req.params.id));
      if (!campaign) {
        return res.status(404).json({ message: 'Campaign not found' });
      }
      res.json(campaign);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching campaign' });
    }
  });

  app.post('/api/campaigns', authenticateToken, async (req, res) => {
    try {
      const campaignData = insertCampaignSchema.parse({
        ...req.body,
        userId: req.user.id
      });
      
      const campaign = await storage.createCampaign(campaignData);
      res.status(201).json(campaign);
    } catch (error) {
      console.error('Campaign creation error:', error);
      res.status(400).json({ message: 'Invalid campaign data' });
    }
  });

  // Donation routes
  app.post('/api/donations/initiate', async (req, res) => {
    try {
      const donationData = insertFinancialDonationSchema.parse(req.body);
      
      const donation = await storage.createDonation(donationData);
      
      // Here you would integrate with actual mobile money API
      // For now, we'll simulate the process
      
      res.status(201).json({
        donation,
        message: 'Donation initiated. You will receive SMS/notification to complete payment.'
      });
    } catch (error) {
      console.error('Donation error:', error);
      res.status(400).json({ message: 'Invalid donation data' });
    }
  });

  app.post('/api/donations/callback/:operator', async (req, res) => {
    try {
      const { operator } = req.params;
      const { transaction_id, status, amount } = req.body;
      
      // Verify the callback signature here (implementation depends on operator)
      
      const donation = await storage.getDonationsByOperatorTxId(transaction_id);
      if (!donation) {
        return res.status(404).json({ message: 'Donation not found' });
      }

      await storage.updateDonation(donation.id, {
        status: status === 'success' ? 'completed' : 'failed',
        operatorTransactionId: transaction_id
      });

      // If successful, update campaign amount
      if (status === 'success') {
        const campaign = await storage.getCampaign(donation.campaignId);
        if (campaign) {
          const newAmount = parseFloat(campaign.currentAmount.toString()) + parseFloat(donation.amount.toString());
          await storage.updateCampaign(campaign.id, {
            currentAmount: newAmount.toString()
          });
        }
      }

      res.json({ message: 'Callback processed' });
    } catch (error) {
      console.error('Callback error:', error);
      res.status(500).json({ message: 'Error processing callback' });
    }
  });

  // Material donations routes
  app.post('/api/material-donations', async (req, res) => {
    try {
      const donationData = insertMaterialDonationSchema.parse(req.body);
      const donation = await storage.createMaterialDonation(donationData);
      res.status(201).json(donation);
    } catch (error) {
      console.error('Material donation error:', error);
      res.status(400).json({ message: 'Invalid donation data' });
    }
  });

  // Boutique routes
  app.get('/api/boutique/items', async (req, res) => {
    try {
      const { status = 'available', category } = req.query;
      const items = await storage.getBoutiqueItems(status as string, category as string);
      res.json(items);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching boutique items' });
    }
  });

  app.get('/api/boutique/items/:id', async (req, res) => {
    try {
      const item = await storage.getBoutiqueItem(parseInt(req.params.id));
      if (!item) {
        return res.status(404).json({ message: 'Item not found' });
      }
      res.json(item);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching item' });
    }
  });

  app.post('/api/boutique/orders', authenticateToken, async (req, res) => {
    try {
      const orderData = insertBoutiqueOrderSchema.parse({
        ...req.body,
        userId: req.user.id
      });
      
      const order = await storage.createBoutiqueOrder(orderData);
      res.status(201).json(order);
    } catch (error) {
      console.error('Order creation error:', error);
      res.status(400).json({ message: 'Invalid order data' });
    }
  });

  // User routes
  app.get('/api/users/me/campaigns', authenticateToken, async (req, res) => {
    try {
      const campaigns = await storage.getUserCampaigns(req.user.id);
      res.json(campaigns);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching user campaigns' });
    }
  });

  app.get('/api/users/me/orders', authenticateToken, async (req, res) => {
    try {
      const orders = await storage.getUserOrders(req.user.id);
      res.json(orders);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching user orders' });
    }
  });

  app.put('/api/users/me', authenticateToken, async (req, res) => {
    try {
      const updates = req.body;
      
      // Hash password if provided
      if (updates.password) {
        updates.passwordHash = await bcrypt.hash(updates.password, 10);
        delete updates.password;
      }
      
      const user = await storage.updateUser(req.user.id, updates);
      res.json({ user });
    } catch (error) {
      res.status(500).json({ message: 'Error updating user' });
    }
  });

  // Admin routes
  app.get('/api/admin/campaigns/pending', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const campaigns = await storage.getCampaigns('pending');
      res.json(campaigns);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching pending campaigns' });
    }
  });

  app.put('/api/admin/campaigns/:id/status', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { status } = req.body;
      const campaign = await storage.updateCampaign(parseInt(req.params.id), { status });
      res.json(campaign);
    } catch (error) {
      res.status(500).json({ message: 'Error updating campaign status' });
    }
  });

  app.get('/api/admin/material-donations/pending', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const donations = await storage.getMaterialDonations('pending_verification');
      res.json(donations);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching pending material donations' });
    }
  });

  app.post('/api/admin/material-donations/:id/publish', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const donationId = parseInt(req.params.id);
      const { title, description, category } = req.body;
      
      // Update material donation status
      await storage.updateMaterialDonation(donationId, { 
        status: 'published_in_store' 
      });
      
      // Create boutique item
      const item = await storage.createBoutiqueItem({
        sourceDonationId: donationId,
        title,
        description,
        category,
        publishedByAdminId: req.user.id
      });
      
      res.json(item);
    } catch (error) {
      console.error('Publishing error:', error);
      res.status(500).json({ message: 'Error publishing item' });
    }
  });

  app.get('/api/admin/boutique/orders/pending', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const orders = await storage.getBoutiqueOrders('pending_approval');
      res.json(orders);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching pending orders' });
    }
  });

  app.put('/api/admin/boutique/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { status } = req.body;
      const order = await storage.updateBoutiqueOrder(parseInt(req.params.id), {
        status,
        handledByAdminId: req.user.id
      });
      res.json(order);
    } catch (error) {
      res.status(500).json({ message: 'Error updating order status' });
    }
  });

  app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching users' });
    }
  });

  app.put('/api/admin/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { status } = req.body;
      const user = await storage.updateUser(parseInt(req.params.id), { status });
      res.json(user);
    } catch (error) {
      res.status(500).json({ message: 'Error updating user status' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
