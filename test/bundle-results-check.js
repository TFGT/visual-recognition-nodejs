'use strict';
// this file is to validate that the test images we supply get proper results with the various class bundles
// it simply creates every permutation of classifiers (only 20 per category since we require a minimum of 3 selected) and then checks every image to ensure it's getting the expected classification

/* eslint no-console: 0, no-shadow: 0, no-param-reassign: 0, padded-blocks: 0 */

var fs = require('fs');
var path = require('path');
var async = require('async');
var getCombinations = require('combinations');
require('dotenv').config({silent: true});
var watson = require('watson-developer-cloud');

// Create the service wrapper
var visualRecognition = watson.visual_recognition({
  version: 'v3',
  api_key: process.env.API_KEY || '<api-key>',
  version_date: '2015-05-19'
});

// we could embed the expected category into the filename, but then someone might think the service was cheating. so, this will do for now.
var testImages = {
    // this maps to public/images/bundles/dogs/test/{index}.jpg
  dogs: [
    'husky',
    false,
    'dalmation',
    false,
    'beagle',
    'goldenretriever',
    'husky' // same as 0 except with wrong proportions
  ],
  fruits: [
    'peach',
    false,
    false,
    'apple',
    'grapes',
    'banana',
    'pear',
    'orange'
  ],
  insurance: [
    'motorcycleaccident',
    false,
    'vandalism',
    false,
    'motorcycleaccident',
    'flattire',
    'vandalism',
    null, // there is no 8.jpg :(
    'brokenwindshield'
  ],
  moleskine: [
        // notes:
        //
        // notebook vs journal: I think a notebook has a hard cover, an elastic band, and a ribbon to keep your place,
        // whereas a journal has a paper cover and no ribbon or elastic
        //
        // I'm not entirely sure if 'portrait' vs 'landscape' was intended to classify the orientation or the contents...
        // I would guess the former except that all the sample images all showing drawings of landscapes and people (?)
        //
        // Either way, I think each image should probably have two classifications.. but the training data isn't
        // sufficient to do that reliably

    'journaling', // watson incorrectly classifies this one - sometimes it's both jouraling and notebook, other times it's neither
    false,
    'landscape',
    'landscape',
    false,
    'landscape',
    false,
    'journaling',
    'journaling', // ?
    'journaling',
    'landscape', // 10.jpg
    false,
    'portrait',
    false,
    'portrait',
    'portrait', // 15.jpg
    null,
    false,
    'landscape'
  ],
  omniearth: [
    'baseball',
    'baseball',
    'cars',
    false, // I think this might actually be a car, but I'm honestly not sure
    'tennis',
    'golf', // 5.jpg
    'cars',
    'cars',
    'golf',
    'golf',
    'golf', // 10.jpg
    null,
    'golf',
    'golf',
    'tennis',
    null, // 15
    'tennis',
    'cars',
    null,
    null,
    'cars' // 20.jpg
  ]
};

var basedir = path.join(__dirname, '../public/images/bundles');

var MIN_TAGS = 3;

var permutations = fs.readdirSync(basedir).filter(function(filename) {
  return fs.statSync(path.join(basedir, filename)).isDirectory();
}).map(function(catName) {
  return {
    category: catName,
    classes: fs.readdirSync(path.join(basedir, catName)).filter(function(filename) {
      return path.extname(filename) === '.zip';
    }).map(function(filename) {
      return path.basename(filename, '.zip');
    }),
    testImages: testImages[catName]
  };
}).reduce(function(perms, cat) {
  var newPerms = getCombinations(cat.classes, MIN_TAGS).map(function(classes) {
    return {
      category: cat.category,
      classes: classes,
      testImages: cat.testImages
    };
  });
  return perms.concat(newPerms);
}, []);

var POLLING_DELAY = 2000; // ms: 2000 == 2 seconds
function classifierDone(id, next) {
  visualRecognition.getClassifier({classifier_id: id}, function(err, res) {
    if (err) {
      return next(err);
    }

    if (res.status === 'ready') {
      return next();
    } else if (res.status === 'failed') {
      return next(res);
    } else {
      setTimeout(classifierDone.bind(null, id, next), POLLING_DELAY);
    }
  });
}

// set up a queue to handle each permutation with CONCURRENCY parallel workers
var CONCURRENCY = 10;
console.log('Running test images against %s classifier permutations with concurrency %s', permutations.length, CONCURRENCY);
async.eachLimit(permutations, CONCURRENCY, function(perm, done) {
  // don't pass errors back to async, just log them (we want
  function cleanup(err) {
    if (err) {
      perm.error = err.message || err;
      console.log(perm, err);
    }
    if (perm.classifier) {
      visualRecognition.deleteClassifier(perm.classifier, function(delerr) {
        if (delerr) {
          perm.classifier.error = delerr.message || err;
          console.log('error deleting classifier', perm.classifier, delerr);
        }
        perm.classifier.deleted = !delerr;
        done();
      });
      perm.complete = true;
    } else {
      done();
    }
  }

  // match the test image files to the expected class
  perm.tests = perm.testImages.map(function(tag, index) {
    if (tag === null) {
      return tag;
    }
    return {
      'class': tag,
      filename: index + '.jpg'
    };
  }).filter(function(test) {
    return test; // filter out the nulls (we need them up until now to keep the indexes lined up with the filenames)
  });


  // create the classifier
  var classifierOptions = {
    name: [perm.category].concat(perm.classes).join('_')
  };
  perm.classes.forEach(function(tag) {
    var key =  (tag.match(/negative|non-fruit/)) ? 'negative_examples' : tag + '_positive_examples';
    classifierOptions[key] = fs.createReadStream(path.join(basedir, perm.category, tag + '.zip'));
  });
  visualRecognition.createClassifier(classifierOptions, function(err, classifier) {
    if (err) {
      return cleanup(err);
    }
    perm.classifier = classifier;

    // wait until it's finished processing
    classifierDone(classifier.classifier_id, function(err) {
      if (err) {
        return cleanup(err);
      }

      console.log('classifier ready')

      perm.tests.forEach(function(test) {
        test.errors = [];
        test.iterations = 0;
        test.results = [];
      });

      var runTest = async.retryable(3, function(test, next) {
        test.iterations++;

        visualRecognition.classify({
          classifier_ids: [classifier.classifier_id],
          images_file: fs.createReadStream(path.join(basedir, perm.category, 'test', test.filename))
        }, function(err, res) {
          if (err) {
            test.errors.push(err.message || err);
            return next(err);
          }

          test.results.push(res);

          if (res.images_processed !== 1) {
            test.errors.push('Incorrect number of images processed');
            return next(err);
          }

          var expected = (test.class && perm.classes.indexOf(test.class) > -1) ? test.class : false;

          var actual = res.images[0].classifiers.length  ? res.images[0].classifiers[0].classes : [];

          var success;
          if (expected) {
            success = actual.length && actual[0].class === test.class;
          } else {
            success = actual.length === 0;
          }

          test.success = success;

          console.log('%s (%s: %s) Test image %s should have class %s', success ? '✓' : 'x', perm.category, perm.classes, test.filename, test.class);
          if (!success) {
            test.actual = actual;
            console.log(actual.length  ? actual : '[no classifications returned]');
          }
          test.complete = true;
          next();
        });
    });

    async.eachLimit(perm.tests, CONCURRENCY, function(test, next) {
        runTest(test, next.bind(null, null)); // no errors returned so that subsequent tests still run
      });
    }, cleanup);

  });
}, function(err) {
  if (err) {
    console.log('fatal error', err);
  } else {
    console.log('Completed.');
  }
  var outfile = './bundle-permutations.json';
  fs.writeFileSync(outfile, JSON.stringify(permutations));
  console.log('details written to %s', outfile);
});


exports.permutations = permutations;
