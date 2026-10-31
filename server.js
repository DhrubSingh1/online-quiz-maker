const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const expressLayouts = require('express-ejs-layouts');
const pool = require('./config/db');
require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(expressLayouts);
app.set('view engine', 'ejs');

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
};

// Routes
app.get('/', (req, res) => res.render('index'));

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.render('register', { error: 'Email already registered.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );
    req.session.user = newUser.rows[0];
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Server error during registration.' });
  }
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.render('login', { error: 'Invalid email or password.' });
    }
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.render('login', { error: 'Invalid email or password.' });
    }
    req.session.user = { id: user.id, name: user.name, email: user.email };
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Server error during login.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const quizzes = await pool.query(
      'SELECT * FROM quizzes WHERE creator_id = $1 ORDER BY created_at DESC',
      [req.session.user.id]
    );
    res.render('dashboard', { quizzes: quizzes.rows, host: req.headers.host });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.get('/create-quiz', requireAuth, (req, res) => res.render('create-quiz'));
app.post('/create-quiz', requireAuth, async (req, res) => {
  const { title, description, timer_minutes, questions } = req.body;
  const shareCode = crypto.randomBytes(4).toString('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quizRes = await client.query(
      'INSERT INTO quizzes (title, description, timer_minutes, share_code, creator_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [title, description, parseInt(timer_minutes) || 0, shareCode, req.session.user.id]
    );
    const quizId = quizRes.rows[0].id;

    if (questions) {
      for (let q of questions) {
        await client.query(
          'INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [quizId, q.text, q.optionA, q.optionB, q.optionC, q.optionD, q.correct]
        );
      }
    }

    await client.query('COMMIT');
    res.redirect('/dashboard');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Failed to create quiz');
  } finally {
    client.release();
  }
});

app.get('/quiz-results/:id', requireAuth, async (req, res) => {
  try {
    const quizRes = await pool.query('SELECT * FROM quizzes WHERE id = $1 AND creator_id = $2', [
      req.params.id,
      req.session.user.id
    ]);
    if (quizRes.rows.length === 0) return res.status(404).send('Quiz not found');

    const submissions = await pool.query(
      'SELECT * FROM submissions WHERE quiz_id = $1 ORDER BY submitted_at DESC',
      [req.params.id]
    );

    res.render('quiz-results', { quiz: quizRes.rows[0], submissions: submissions.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.get('/explore', async (req, res) => {
  try {
    const quizzes = await pool.query(
      'SELECT q.*, u.name as creator_name FROM quizzes q JOIN users u ON q.creator_id = u.id ORDER BY q.created_at DESC'
    );
    res.render('explore', { quizzes: quizzes.rows, host: req.headers.host });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// 1. Quiz Intro Page
app.get('/quiz/:code', async (req, res) => {
  try {
    const quizRes = await pool.query(
      'SELECT q.*, u.name as creator_name FROM quizzes q JOIN users u ON q.creator_id = u.id WHERE q.share_code = $1',
      [req.params.code]
    );
    if (quizRes.rows.length === 0) return res.status(404).send('Quiz not found');

    res.render('quiz-intro', { quiz: quizRes.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// 2. Start Quiz (Store participant info in session & redirect to questions)
app.post('/quiz/:code/start', (req, res) => {
  const { participant_name, participant_email } = req.body;
  req.session.currentParticipant = {
    name: participant_name,
    email: participant_email,
    code: req.params.code
  };
  res.redirect(`/quiz/${req.params.code}/take`);
});

// 3. Quiz Questions Page
app.get('/quiz/:code/take', async (req, res) => {
  const participant = req.session.currentParticipant;
  if (!participant || participant.code !== req.params.code) {
    return res.redirect(`/quiz/${req.params.code}`);
  }

  try {
    const quizRes = await pool.query('SELECT * FROM quizzes WHERE share_code = $1', [req.params.code]);
    if (quizRes.rows.length === 0) return res.status(404).send('Quiz not found');

    const quiz = quizRes.rows[0];
    const questionsRes = await pool.query(
      'SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE quiz_id = $1',
      [quiz.id]
    );

    res.render('take-quiz', { quiz, questions: questionsRes.rows, participant });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// 4. Submit Quiz
app.post('/quiz/:code/submit', async (req, res) => {
  const participant = req.session.currentParticipant;
  if (!participant || participant.code !== req.params.code) {
    return res.redirect(`/quiz/${req.params.code}`);
  }

  const { answers } = req.body;
  try {
    const quizRes = await pool.query('SELECT * FROM quizzes WHERE share_code = $1', [req.params.code]);
    if (quizRes.rows.length === 0) return res.status(404).send('Quiz not found');

    const quiz = quizRes.rows[0];
    const questions = await pool.query('SELECT id, correct_option FROM questions WHERE quiz_id = $1', [
      quiz.id
    ]);

    let score = 0;
    questions.rows.forEach((q) => {
      const selectedOption = answers ? answers[q.id] : null;
      if (selectedOption === q.correct_option) score++;
    });

    await pool.query(
      'INSERT INTO submissions (quiz_id, participant_name, participant_email, score, total_questions) VALUES ($1, $2, $3, $4, $5)',
      [quiz.id, participant.name, participant.email, score, questions.rows.length]
    );

    delete req.session.currentParticipant;

    res.render('quiz-score', {
      quizTitle: quiz.title,
      participantName: participant.name,
      score,
      total: questions.rows.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error submitting quiz');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));