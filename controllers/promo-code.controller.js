const { getDb } = require('../db/database');

function getAllPromoCodes(req, res) {
  try {
    const db = getDb();
    const promoCodes = db.prepare(`
      SELECT pc.*, u.name as agent_name, u.email as agent_email
      FROM promo_codes pc
      LEFT JOIN users u ON u.id = pc.agent_id
      ORDER BY pc.created_at DESC
    `).all();
    
    res.json(promoCodes);
  } catch (error) {
    console.error('Error fetching promo codes:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function getPromoCodeById(req, res) {
  try {
    const { id } = req.params;
    const db = getDb();
    
    const promoCode = db.prepare(`
      SELECT pc.*, u.name as agent_name, u.email as agent_email
      FROM promo_codes pc
      LEFT JOIN users u ON u.id = pc.agent_id
      WHERE pc.id = ?
    `).get(id);
    
    if (!promoCode) {
      return res.status(404).json({ message: 'Promo code not found' });
    }
    
    res.json(promoCode);
  } catch (error) {
    console.error('Error fetching promo code:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function createPromoCode(req, res) {
  try {
    const { code, agent_id, discount_percent, max_uses, valid_until } = req.body;
    
    if (!code || !agent_id || !discount_percent) {
      return res.status(400).json({ message: 'Code, agent ID, and discount percent are required' });
    }
    
    const db = getDb();
    
    // Check if code already exists
    const existingCode = db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(code);
    if (existingCode) {
      return res.status(400).json({ message: 'Promo code already exists' });
    }
    
    // Verify agent exists
    const agent = db.prepare('SELECT id, name FROM users WHERE id = ? AND role = ?').get(agent_id, 'agent');
    if (!agent) {
      return res.status(400).json({ message: 'Invalid agent ID' });
    }
    
    const result = db.prepare(`
      INSERT INTO promo_codes (code, agent_id, discount_percent, max_uses, valid_until)
      VALUES (?, ?, ?, ?, ?)
    `).run(code, agent_id, discount_percent, max_uses || 0, valid_until || null);
    
    const newPromoCode = db.prepare(`
      SELECT pc.*, u.name as agent_name, u.email as agent_email
      FROM promo_codes pc
      LEFT JOIN users u ON u.id = pc.agent_id
      WHERE pc.id = ?
    `).get(result.lastInsertRowid);
    
    res.status(201).json(newPromoCode);
  } catch (error) {
    console.error('Error creating promo code:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function updatePromoCode(req, res) {
  try {
    const { id } = req.params;
    const { code, agent_id, discount_percent, max_uses, status, valid_until } = req.body;
    
    const db = getDb();
    
    // Check if promo code exists
    const existingPromoCode = db.prepare('SELECT id FROM promo_codes WHERE id = ?').get(id);
    if (!existingPromoCode) {
      return res.status(404).json({ message: 'Promo code not found' });
    }
    
    // If code is being changed, check if new code already exists
    if (code) {
      const existingCode = db.prepare('SELECT id FROM promo_codes WHERE code = ? AND id != ?').get(code, id);
      if (existingCode) {
        return res.status(400).json({ message: 'Promo code already exists' });
      }
    }
    
    // If agent_id is being changed, verify agent exists
    if (agent_id) {
      const agent = db.prepare('SELECT id, name FROM users WHERE id = ? AND role = ?').get(agent_id, 'agent');
      if (!agent) {
        return res.status(400).json({ message: 'Invalid agent ID' });
      }
    }
    
    const updateFields = [];
    const updateValues = [];
    
    if (code !== undefined) {
      updateFields.push('code = ?');
      updateValues.push(code);
    }
    if (agent_id !== undefined) {
      updateFields.push('agent_id = ?');
      updateValues.push(agent_id);
    }
    if (discount_percent !== undefined) {
      updateFields.push('discount_percent = ?');
      updateValues.push(discount_percent);
    }
    if (max_uses !== undefined) {
      updateFields.push('max_uses = ?');
      updateValues.push(max_uses);
    }
    if (status !== undefined) {
      updateFields.push('status = ?');
      updateValues.push(status);
    }
    if (valid_until !== undefined) {
      updateFields.push('valid_until = ?');
      updateValues.push(valid_until);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }
    
    updateValues.push(id);
    
    db.prepare(`
      UPDATE promo_codes 
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `).run(...updateValues);
    
    const updatedPromoCode = db.prepare(`
      SELECT pc.*, u.name as agent_name, u.email as agent_email
      FROM promo_codes pc
      LEFT JOIN users u ON u.id = pc.agent_id
      WHERE pc.id = ?
    `).get(id);
    
    res.json(updatedPromoCode);
  } catch (error) {
    console.error('Error updating promo code:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function deletePromoCode(req, res) {
  try {
    const { id } = req.params;
    const db = getDb();
    
    // Check if promo code exists
    const existingPromoCode = db.prepare('SELECT id FROM promo_codes WHERE id = ?').get(id);
    if (!existingPromoCode) {
      return res.status(404).json({ message: 'Promo code not found' });
    }
    
    db.prepare('DELETE FROM promo_codes WHERE id = ?').run(id);
    
    res.json({ message: 'Promo code deleted successfully' });
  } catch (error) {
    console.error('Error deleting promo code:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function getAgents(req, res) {
  try {
    const db = getDb();
    const agents = db.prepare(`
      SELECT id, name, email, phone
      FROM users 
      WHERE role = 'agent' 
      ORDER BY name
    `).all();
    
    res.json(agents);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function getAgentReferrals(req, res) {
  try {
    const { agent_id } = req.params;
    const db = getDb();
    
    const referrals = db.prepare(`
      SELECT ar.*, 
             u.name as customer_name, 
             u.email as customer_email,
             b.booking_ref,
             b.total_amount,
             b.created_at as booking_date,
             pc.code as promo_code,
             pc.discount_percent
      FROM agent_referrals ar
      LEFT JOIN users u ON u.id = ar.customer_id
      LEFT JOIN bookings b ON b.id = ar.booking_id
      LEFT JOIN promo_codes pc ON pc.id = ar.promo_code_id
      WHERE ar.agent_id = ?
      ORDER BY ar.created_at DESC
    `).all(agent_id);
    
    res.json(referrals);
  } catch (error) {
    console.error('Error fetching agent referrals:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

function validatePromoCode(req, res) {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ message: 'Promo code is required' });
    }
    
    const db = getDb();
    const promoCode = db.prepare(`
      SELECT pc.*, u.name as agent_name
      FROM promo_codes pc
      LEFT JOIN users u ON u.id = pc.agent_id
      WHERE pc.code = ? AND pc.status = 'active'
    `).get(code);
    
    if (!promoCode) {
      return res.status(404).json({ message: 'Invalid promo code' });
    }
    
    // Check if promo code is still valid
    if (promoCode.valid_until && new Date(promoCode.valid_until) < new Date()) {
      return res.status(400).json({ message: 'Promo code has expired' });
    }
    
    // Check if max uses reached
    if (promoCode.max_uses > 0 && promoCode.used_count >= promoCode.max_uses) {
      return res.status(400).json({ message: 'Promo code usage limit reached' });
    }
    
    res.json({
      valid: true,
      discount_percent: promoCode.discount_percent,
      agent_name: promoCode.agent_name
    });
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  getAllPromoCodes,
  getPromoCodeById,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  getAgents,
  getAgentReferrals,
  validatePromoCode
};
