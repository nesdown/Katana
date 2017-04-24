# _*_ coding: utf-8 _*_

import urllib
import urllib2
import sys
import random
import time
import mechanize
from twython import Twython
from bs4 import BeautifulSoup
from textblob import TextBlob
import requests
import re
import os
import codecs
import json as m_json


# Initialize Twitter API, api.update_status(status=sth) is for posts
# Use OAuth2 with simplified api key/token declaring
reload(sys)
random.seed()
sys.setdefaultencoding('utf-8')

#api=Twython()
apiKey = '3bUs0Tlb10fE5WbZNWHJGh2HF'
apiSecret = 'lsOr9dXOCJUemV8gXAeB6Y2DSOKLe7FzXnyajAjrKNTImRPTbA'
accessToken = '848565189486288896-4LcBn6t1KyJ1nyez48Nyy9isp5ll4tP'
accessTokenSecret = 'Lhrp5l3o5uNNeC1UbY5GRtuWXlK1LOBWavVnTO47GYYI5'
#def authorizeBot():
api=Twython(apiKey, apiSecret, accessToken, accessTokenSecret)



# Initialize all data needed
urls = ["site1", "site2", "site3", "site4", "site5"]
copyrights = [" (sitename1)", " (sitename2)", " (sitename3)", " (sitename4)", " (sitename5)"]
mediaId = ""

source1Temp = []
source1Final = []


# Creating funcs for different sources
def sourceCut(url):
    # Initialize stuff
    curNews = ""
    soup = BeautifulSoup(url.text, "html5lib")

    # Get unedited news file
    for title in soup.findAll('a'):
        curNews = curNews + unicode(title.string)

    source1Temp = curNews.split("None")

    for i in range(15, 20):
        source1Final.append(source1Temp[i])

    # This one is for test print of array
    #	for i in range(len(source1Final)):
    #		print(source1Final[i])




# Check if storyfile contains current news
def checkPost(postText):
    flag = False
    with open("history.txt") as historyFile:
        for line in historyFile:
            if postText in line:
                flag = True
                print("History already contains this: " + postText)
                break
            else:
                flag = False
    return flag


# Getting an image for the tweet
def get_soup(url, header):
    return BeautifulSoup(urllib2.urlopen(urllib2.Request(url, headers=header)), "html5lib")


def translate(word):
    try:
        print("Keyword to translate: " + word)
        blob = TextBlob(word)
        return blob.translate(to='en')
    except:
        return "social"


def findImage(tweet):
    tweetList = tweet.split(" ")
    wordNum = random.randrange(len(tweetList))
    keyword = tweetList[wordNum]
    keywordTranslated = translate(keyword)
    print keywordTranslated

    # use Bing search engine
    url = "https://www.bing.com/images/search?q=" + str(keywordTranslated)

    browser = mechanize.Browser()
    browser.set_handle_robots(False)
    browser.addheaders = [('User-agent', 'Mozilla')]
    urlFin = browser.open(url)

    soup = BeautifulSoup(urlFin, "html5lib")
    res = soup.findAll("a", {"class": "thumb"})
    cur = res[0]
    print(cur['href'])

    urllib.urlretrieve(cur['href'], "photo.png")


#Tweeting just text function
def tweetPost(tweet):
    api.update_status(status=tweet)

def tweetWithImage(tweet, photoPath):
    photo = open(photoPath, "rb")
    api.update_status_with_media(status=tweet, media=photo)


# Tweeting w image function
def lazyMake():
    sourceNum = 0
    postNum = random.randrange(0, 5)
    print("source: " + str(sourceNum) + " post: " + str(postNum))
    tweetStr = ""
    author = ""

    if sourceNum == 0:
        sourceCut(requests.get(urls[0]))
        tweetStr = source1Final[postNum]
        author = copyrights[0]
        findImage(tweetStr)

    else:
        print("The process of making post went wrong.")
        return

    res = checkPost(tweetStr)
    print ("Flag value: " + str(res))
    if res == True:
        print("News has already been posted. Searching for another news.")
    elif res == False:
        toTweet = tweetStr + author
        photo = open("photo.png", "rb")
        api.update_status_with_media(status=toTweet, media=photo)
        with codecs.open("history.txt", "a", "utf-8-sig") as log:
            log.write(tweetStr + "\n")
        print("Tweet posted: " + toTweet)
        time.sleep(1800)
        lazyMake()


# And here we go!


#Just postst text
def runSimpleBot(tweetText, delay):
    #while True:
    try:
        api.update_status(status=tweetText)
        print("\nSuccessfully posted: " + tweetText)
    except:
        print("An error occured")

    print("-------------------------\n\n")
    time.sleep(delay)



#Posts text with image
def runFullBot(tweetText, photoPath, delay):
    try:
        tweetWithImage(status=tweetText, media=photoPath)
        print("\nSuccessfully posted: " + tweetText)
    except:
        print("An error occured")

    print("-------------------------\n\n")
    time.sleep(delay)




#Strong and independent :З
def runLazyBotFull():
        while True:
            try:
                lazyMake()
            except:
                print("An error occured")
                continue

            print("------------------------\n\n")
